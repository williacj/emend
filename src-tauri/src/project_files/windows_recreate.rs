// ABOUTME: Windows TD-18 Recreate adapter with transaction-long kernel handle confinement.
// ABOUTME: Walks no-follow relative handles and atomically publishes a locked sibling temp.

use std::ffi::{c_void, OsStr, OsString};
use std::fs::File;
use std::io::{self, Write};
use std::mem::size_of;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Component, Path};
use std::ptr;

use uuid::Uuid;
use windows_sys::Win32::Foundation::{
    RtlNtStatusToDosError, HANDLE, INVALID_HANDLE_VALUE, NTSTATUS, OBJ_CASE_INSENSITIVE,
    OBJ_DONT_REPARSE, UNICODE_STRING,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FileAttributeTagInfo, FileDispositionInfo, GetDriveTypeW,
    GetFileInformationByHandleEx, GetVolumeInformationByHandleW, GetVolumePathNameW,
    SetFileInformationByHandle, DELETE, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_ATTRIBUTE_TAG_INFO, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_WRITE, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, OPEN_EXISTING, SYNCHRONIZE,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

use super::{
    RecreateAdapter, RecreateAdapterError, RecreateCapabilityStatus, RecreatePublishStatus,
    RecreateTransaction,
};

const FILE_OPEN: u32 = 1;
const FILE_CREATE: u32 = 2;
const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;
const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0000_0020;
const FILE_NON_DIRECTORY_FILE: u32 = 0x0000_0040;
const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_RENAME_INFORMATION_EX: i32 = 65;
const DRIVE_FIXED: u32 = 3;
const NTFS_NAME_CAPACITY: usize = 32;
const VOLUME_PATH_CAPACITY: usize = 32_768;
const TEMP_CREATE_ATTEMPTS: usize = 16;

#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root_directory: HANDLE,
    object_name: *const UNICODE_STRING,
    attributes: u32,
    security_descriptor: *const c_void,
    security_quality_of_service: *const c_void,
}

#[repr(C)]
struct FileRenameInformationEx {
    flags: u32,
    root_directory: HANDLE,
    file_name_length: u32,
    file_name: [u16; 1],
}

#[link(name = "ntdll")]
extern "system" {
    fn NtCreateFile(
        file_handle: *mut HANDLE,
        desired_access: u32,
        object_attributes: *const ObjectAttributes,
        io_status_block: *mut IO_STATUS_BLOCK,
        allocation_size: *const i64,
        file_attributes: u32,
        share_access: u32,
        create_disposition: u32,
        create_options: u32,
        ea_buffer: *const c_void,
        ea_length: u32,
    ) -> NTSTATUS;

    fn NtSetInformationFile(
        file_handle: HANDLE,
        io_status_block: *mut IO_STATUS_BLOCK,
        file_information: *mut c_void,
        length: u32,
        file_information_class: i32,
    ) -> NTSTATUS;
}

/// The sole v1 qualifying Recreate adapter (TD-18). Availability remains path-specific: every
/// query and invocation reopens the complete route and accepts only a real NTFS volume whose
/// no-delete-sharing and no-follow primitives succeed for that exact path.
#[derive(Default)]
pub struct WindowsRecreateAdapter;

impl RecreateAdapter for WindowsRecreateAdapter {
    fn capability(&self, root: &Path, path: &Path) -> RecreateCapabilityStatus {
        match LockedRoute::acquire(root, path) {
            Ok(_) => RecreateCapabilityStatus::Available,
            Err(_) => RecreateCapabilityStatus::ConfinementUnavailable,
        }
    }

    fn acquire(
        &self,
        root: &Path,
        path: &Path,
    ) -> Result<Box<dyn RecreateTransaction>, RecreateAdapterError> {
        self.acquire_transaction(root, path)
            .map(|transaction| Box::new(transaction) as Box<dyn RecreateTransaction>)
            .map_err(|_| RecreateAdapterError::ConfinementUnavailable)
    }
}

impl WindowsRecreateAdapter {
    fn acquire_transaction(
        &self,
        root: &Path,
        path: &Path,
    ) -> io::Result<WindowsRecreateTransaction> {
        let route = LockedRoute::acquire(root, path)?;
        Ok(WindowsRecreateTransaction { route })
    }
}

struct LockedRoute {
    handles: Vec<OwnedHandle>,
    target_name: OsString,
}

impl LockedRoute {
    fn acquire(root: &Path, path: &Path) -> io::Result<Self> {
        let (ancestors, target_name) = split_target(path)?;
        let root_handle = open_root(root)?;
        reject_reparse(&root_handle)?;
        require_fixed_volume(root)?;
        require_ntfs(&root_handle)?;

        let mut handles = vec![root_handle];
        for ancestor in ancestors {
            let handle = open_relative_directory(handles.last().unwrap(), &ancestor)?;
            reject_reparse(&handle)?;
            handles.push(handle);
        }

        Ok(Self {
            handles,
            target_name,
        })
    }
}

struct WindowsRecreateTransaction {
    route: LockedRoute,
}

impl RecreateTransaction for WindowsRecreateTransaction {
    fn publish(self: Box<Self>, content: &[u8]) -> Result<RecreatePublishStatus, String> {
        (*self).publish_with_hook(content, |_, _| {})
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PublishStage {
    TempCreated,
    TempFlushed,
    Published,
}

impl WindowsRecreateTransaction {
    fn publish_with_hook<F>(
        self,
        content: &[u8],
        mut hook: F,
    ) -> Result<RecreatePublishStatus, String>
    where
        F: FnMut(PublishStage, &OsStr),
    {
        let (mut temp, temp_name) = self
            .create_temp()
            .map_err(|error| format!("could not create confined Recreate temp: {error}"))?;
        hook(PublishStage::TempCreated, &temp_name);

        temp.file
            .write_all(content)
            .map_err(|error| format!("could not write confined Recreate temp: {error}"))?;
        temp.file
            .sync_all()
            .map_err(|error| format!("could not flush confined Recreate temp: {error}"))?;
        hook(PublishStage::TempFlushed, &temp_name);

        let parent = self.route.handles.last().unwrap().as_raw_handle() as HANDLE;
        match rename_no_replace(&temp.file, parent, &self.route.target_name) {
            Ok(()) => {
                temp.published = true;
                hook(PublishStage::Published, &temp_name);
                Ok(RecreatePublishStatus::Created)
            }
            Err(error) if is_name_collision(&error) => Ok(RecreatePublishStatus::Reappeared),
            Err(error) => Err(format!("could not publish confined Recreate temp: {error}")),
        }
    }

    fn create_temp(&self) -> io::Result<(TemporaryFile, OsString)> {
        let parent = self.route.handles.last().unwrap();
        let mut last_collision = None;
        for _ in 0..TEMP_CREATE_ATTEMPTS {
            let name = OsString::from(format!(".emend-recreate-{}.tmp", Uuid::new_v4().simple()));
            match nt_create_relative(
                parent,
                &name,
                FILE_GENERIC_WRITE | DELETE | SYNCHRONIZE,
                0,
                FILE_CREATE,
                FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
                FILE_ATTRIBUTE_NORMAL,
            ) {
                Ok(handle) => {
                    return Ok((
                        TemporaryFile {
                            file: File::from(handle),
                            published: false,
                        },
                        name,
                    ));
                }
                Err(error) if is_name_collision(&error) => last_collision = Some(error),
                Err(error) => return Err(error),
            }
        }
        Err(last_collision.unwrap_or_else(|| {
            io::Error::new(
                io::ErrorKind::AlreadyExists,
                "could not allocate a unique Recreate temp name",
            )
        }))
    }
}

struct TemporaryFile {
    file: File,
    published: bool,
}

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        if self.published {
            return;
        }
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        // Best-effort cleanup after a failed/no-replace publication. The handle itself retains
        // DELETE access and excludes delete sharing, so cleanup cannot be redirected by path.
        unsafe {
            SetFileInformationByHandle(
                self.file.as_raw_handle() as HANDLE,
                FileDispositionInfo,
                ptr::addr_of!(disposition).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            );
        }
    }
}

fn split_target(path: &Path) -> io::Result<(Vec<OsString>, OsString)> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_os_string()),
            _ => return Err(io::Error::from(io::ErrorKind::InvalidInput)),
        }
    }
    let target = parts
        .pop()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    Ok((parts, target))
}

fn open_root(root: &Path) -> io::Result<OwnedHandle> {
    let wide: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle.cast()) })
}

fn open_relative_directory(parent: &OwnedHandle, name: &OsStr) -> io::Result<OwnedHandle> {
    nt_create_relative(
        parent,
        name,
        FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        FILE_OPEN,
        FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        FILE_ATTRIBUTE_NORMAL,
    )
}

fn nt_create_relative(
    parent: &OwnedHandle,
    name: &OsStr,
    desired_access: u32,
    share_access: u32,
    create_disposition: u32,
    create_options: u32,
    file_attributes: u32,
) -> io::Result<OwnedHandle> {
    let mut wide: Vec<u16> = name.encode_wide().collect();
    let byte_len = wide
        .len()
        .checked_mul(size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    let unicode = UNICODE_STRING {
        Length: byte_len,
        MaximumLength: byte_len,
        Buffer: wide.as_mut_ptr(),
    };
    let attributes = ObjectAttributes {
        length: size_of::<ObjectAttributes>() as u32,
        root_directory: parent.as_raw_handle() as HANDLE,
        object_name: ptr::addr_of!(unicode),
        attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        security_descriptor: ptr::null(),
        security_quality_of_service: ptr::null(),
    };
    let mut io_status = IO_STATUS_BLOCK::default();
    let mut handle: HANDLE = ptr::null_mut();
    let status = unsafe {
        NtCreateFile(
            ptr::addr_of_mut!(handle),
            desired_access,
            ptr::addr_of!(attributes),
            ptr::addr_of_mut!(io_status),
            ptr::null(),
            file_attributes,
            share_access,
            create_disposition,
            create_options,
            ptr::null(),
            0,
        )
    };
    if status < 0 {
        let code = unsafe { RtlNtStatusToDosError(status) };
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "NtCreateFile succeeded without a valid handle",
        ));
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle.cast()) })
}

fn reject_reparse(handle: &OwnedHandle) -> io::Result<()> {
    let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
    let succeeded = unsafe {
        GetFileInformationByHandleEx(
            handle.as_raw_handle() as HANDLE,
            FileAttributeTagInfo,
            ptr::addr_of_mut!(info).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    if succeeded == 0 {
        return Err(io::Error::last_os_error());
    }
    if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Recreate route contains a reparse point",
        ));
    }
    Ok(())
}

fn require_ntfs(handle: &OwnedHandle) -> io::Result<()> {
    let mut filesystem_name = [0u16; NTFS_NAME_CAPACITY];
    let succeeded = unsafe {
        GetVolumeInformationByHandleW(
            handle.as_raw_handle() as HANDLE,
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            filesystem_name.as_mut_ptr(),
            filesystem_name.len() as u32,
        )
    };
    if succeeded == 0 {
        return Err(io::Error::last_os_error());
    }
    let length = filesystem_name
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(filesystem_name.len());
    let name = OsString::from_wide(&filesystem_name[..length]);
    if !name.eq_ignore_ascii_case(OsStr::new("NTFS")) {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!("Recreate confinement is unproven on {name:?}"),
        ));
    }
    Ok(())
}

fn require_fixed_volume(root: &Path) -> io::Result<()> {
    let input: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut volume_path = vec![0u16; VOLUME_PATH_CAPACITY];
    let succeeded = unsafe {
        GetVolumePathNameW(
            input.as_ptr(),
            volume_path.as_mut_ptr(),
            volume_path.len() as u32,
        )
    };
    if succeeded == 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { GetDriveTypeW(volume_path.as_ptr()) } != DRIVE_FIXED {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Recreate confinement is proven only on fixed local volumes",
        ));
    }
    Ok(())
}

fn rename_no_replace(file: &File, parent: HANDLE, target_name: &OsStr) -> io::Result<()> {
    let name: Vec<u16> = target_name.encode_wide().collect();
    let name_bytes = name
        .len()
        .checked_mul(size_of::<u16>())
        .and_then(|length| u32::try_from(length).ok())
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    let info_size = size_of::<FileRenameInformationEx>()
        .checked_add(name_bytes as usize)
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    let words = info_size.div_ceil(size_of::<usize>());
    let mut storage = vec![0usize; words];
    let info = storage.as_mut_ptr().cast::<FileRenameInformationEx>();
    unsafe {
        // Deliberately omit FILE_RENAME_REPLACE_IF_EXISTS so a reappeared target wins untouched.
        // The native information class accepts the already-locked destination-directory handle;
        // the Win32 SetFileInformationByHandle wrapper rejects this handle-relative form.
        (*info).flags = 0;
        (*info).root_directory = parent;
        (*info).file_name_length = name_bytes;
        ptr::copy_nonoverlapping(
            name.as_ptr(),
            ptr::addr_of_mut!((*info).file_name).cast::<u16>(),
            name.len(),
        );
    }

    let mut io_status = IO_STATUS_BLOCK::default();
    let status = unsafe {
        NtSetInformationFile(
            file.as_raw_handle() as HANDLE,
            ptr::addr_of_mut!(io_status),
            info.cast(),
            info_size as u32,
            FILE_RENAME_INFORMATION_EX,
        )
    };
    if status < 0 {
        let code = unsafe { RtlNtStatusToDosError(status) };
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    Ok(())
}

fn is_name_collision(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(80 | 183))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier};
    use std::thread;

    use super::*;

    fn assert_barriered_rename_blocked(source: PathBuf, destination: PathBuf) {
        let barrier = Arc::new(Barrier::new(2));
        let worker_barrier = Arc::clone(&barrier);
        let attempted_source = source.clone();
        let attempted_destination = destination.clone();
        let worker = thread::spawn(move || {
            worker_barrier.wait();
            fs::rename(source, destination)
        });
        barrier.wait();
        let error = worker
            .join()
            .unwrap()
            .expect_err("non-delete-shared handle must block relocation");
        assert_eq!(
            error.raw_os_error(),
            Some(32),
            "rename {attempted_source:?} to {attempted_destination:?}: {error}"
        );
    }

    #[test]
    fn windows_route_and_temp_handles_block_relocation_through_atomic_publication() {
        let container = tempfile::TempDir::new().unwrap();
        let root = container.path().join("project");
        let ancestor = root.join("ancestor");
        let parent = ancestor.join("parent");
        fs::create_dir_all(&parent).unwrap();
        let adapter = WindowsRecreateAdapter;
        let transaction = adapter
            .acquire_transaction(&root, Path::new("ancestor/parent/missing.md"))
            .unwrap();
        let mut observed = Vec::new();

        let outcome = transaction
            .publish_with_hook(b"buffer", |stage, temp_name| {
                let temp = parent.join(temp_name);
                for (source, destination) in [
                    (root.clone(), container.path().join("moved root")),
                    (ancestor.clone(), root.join("moved ancestor")),
                    (parent.clone(), ancestor.join("moved parent")),
                ] {
                    assert_barriered_rename_blocked(source, destination);
                }
                match stage {
                    PublishStage::TempCreated => {
                        assert_barriered_rename_blocked(
                            temp.clone(),
                            parent.join("moved temp before write"),
                        );
                    }
                    PublishStage::TempFlushed => {
                        assert_barriered_rename_blocked(
                            temp,
                            parent.join("moved temp after flush"),
                        );
                    }
                    PublishStage::Published => {
                        assert_barriered_rename_blocked(
                            parent.join("missing.md"),
                            parent.join("moved target.md"),
                        );
                    }
                }
                observed.push(stage);
            })
            .unwrap();

        assert_eq!(outcome, RecreatePublishStatus::Created);
        assert_eq!(
            observed,
            vec![
                PublishStage::TempCreated,
                PublishStage::TempFlushed,
                PublishStage::Published
            ]
        );
        assert_eq!(fs::read(parent.join("missing.md")).unwrap(), b"buffer");
    }
}

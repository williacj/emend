// ABOUTME: Claude's native permission callback maps onto the unchanged TD-1 Emend service contract.
// ABOUTME: Opaque input stays at this edge for the allow response; grants bind execution controls.
use super::permission::{PermissionAction, PermissionBroker, PermissionOutcome};
use serde_json::{json, Value};

pub(super) fn claude_request(
    broker: &PermissionBroker,
    run_id: Option<&str>,
    rpc_id: Option<Value>,
    arguments: &Value,
) -> Result<Value, String> {
    let action = arguments
        .get("tool_name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("permission callback requires tool_name")?;
    let input = arguments
        .get("input")
        .filter(|v| v.is_object())
        .ok_or("permission callback requires object input")?
        .clone();
    if arguments.get("tool_use_id").is_some_and(|v| !v.is_string()) {
        return Err("tool_use_id must be a string".into());
    }
    let request = PermissionAction {
        action: action.into(),
        detail: input
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| input.to_string()),
        why: input
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
    };
    let mut execution_key = input.clone();
    // Description is display rationale. Every other field remains bound, including unknown
    // future execution/security controls: a changed sandbox flag must require a new decision.
    execution_key
        .as_object_mut()
        .expect("input object above")
        .remove("description");
    Ok(
        match broker.request_action(run_id, rpc_id, request, execution_key) {
            PermissionOutcome::Allow | PermissionOutcome::AllowAlways => {
                json!({"behavior":"allow","updatedInput":input})
            }
            PermissionOutcome::Deny { reason } => json!({"behavior":"deny","message":reason}),
        },
    )
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct ScriptIdentity {
    path: std::path::PathBuf,
    digest: blake3::Hash,
    interpreter: Option<String>,
    controls: Value,
}

/// Conservative literal shell grammar: no operators, expansions, escapes or interpreter flags.
/// The callback supplies no trusted cwd, so the script itself must have an absolute path.
pub(super) fn script_identity(
    root: &std::path::Path,
    action: &str,
    key: &Value,
) -> Option<ScriptIdentity> {
    use std::io::Read;
    use std::path::Path;
    if action != "Bash" {
        return None;
    }
    let words = literal_words(key.get("command")?.as_str()?)?;
    let first = words.first()?;
    let (script, interpreter) = if matches!(
        first.as_str(),
        "python" | "python3" | "node" | "ruby" | "perl" | "sh" | "bash"
    ) {
        (words.get(1)?, Some(first.clone()))
    } else {
        (first, None)
    };
    if !Path::new(script).is_absolute() {
        return None;
    }
    let path = std::fs::canonicalize(script).ok()?;
    if !path.starts_with(std::fs::canonicalize(root).ok()?) {
        return None;
    }
    // Open without blocking on a substituted FIFO, then require a regular file on the handle.
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(&path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    // A bounded read makes an untrusted callback's eligibility check cheap and fail closed.
    const MAX_SCRIPT_BYTES: u64 = 1024 * 1024;
    let mut contents = Vec::new();
    file.take(MAX_SCRIPT_BYTES + 1)
        .read_to_end(&mut contents)
        .ok()?;
    if contents.len() as u64 > MAX_SCRIPT_BYTES {
        return None;
    }
    if interpreter.is_none() && !contents.starts_with(b"#!") {
        return None;
    }
    let mut controls = key.clone();
    controls.as_object_mut()?.remove("command");
    Some(ScriptIdentity {
        path,
        digest: blake3::hash(&contents),
        interpreter,
        controls,
    })
}

fn literal_words(command: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut started = false;
    for ch in command.chars() {
        if ch.is_control() || (!ch.is_alphanumeric() && !" /._-:=,@%+'\"".contains(ch)) {
            return None;
        }
        if let Some(delimiter) = quote {
            if ch == delimiter {
                quote = None;
            } else {
                word.push(ch);
            }
            continue;
        }
        match ch {
            '\'' | '"' => {
                quote = Some(ch);
                started = true;
            }
            ' ' => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            _ => {
                word.push(ch);
                started = true;
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if started {
        words.push(word);
    }
    Some(words)
}

#[cfg(test)]
mod script_tests {
    use super::*;
    use std::fs;

    // Bash callback spelling uses forward slashes; file I/O keeps the native path.
    fn callback_path(path: &std::path::Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }

    #[test]
    fn script_identity_allows_changed_literal_arguments_but_binds_content_path_and_controls() {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("check citations.py");
        fs::write(&script, "print('original')\n").unwrap();
        let key = |args: &str| json!({"command":format!("python3 '{}' {args}", callback_path(&script)), "timeout":1000});
        let first = script_identity(root.path(), "Bash", &key("--chapter 1"))
            .expect("a verified absolute project script must be eligible");
        assert_eq!(
            Some(first.clone()),
            script_identity(
                root.path(),
                "Bash",
                &key("--chapter 2 'a literal argument'")
            ),
            "changed literal arguments reuse the same script identity"
        );
        let mut changed_control = key("--chapter 2");
        changed_control["dangerouslyDisableSandbox"] = json!(true);
        assert_ne!(
            Some(first.clone()),
            script_identity(root.path(), "Bash", &changed_control),
            "changed execution controls cannot inherit a script grant"
        );
        let other = root.path().join("other.py");
        fs::write(&other, "print('original')\n").unwrap();
        assert_ne!(
            Some(first.clone()),
            script_identity(
                root.path(),
                "Bash",
                &json!({"command":format!("python3 '{}'",callback_path(&other)),"timeout":1000})
            ),
            "same contents at a different script path cannot inherit a grant"
        );
        fs::write(&script, "print('changed')\n").unwrap();
        assert_ne!(
            Some(first),
            script_identity(root.path(), "Bash", &key("--chapter 1")),
            "changed contents cannot inherit a script grant"
        );
    }

    #[test]
    fn script_identity_refuses_relative_compound_dynamic_outside_and_unreadable_targets() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let script = root.path().join("check.py");
        fs::write(&script, "print('ok')\n").unwrap();
        let external = outside.path().join("check.py");
        fs::write(&external, "print('ok')\n").unwrap();
        let base = format!("python3 '{}'", callback_path(&script));
        assert!(
            script_identity(root.path(), "Bash", &json!({"command":base})).is_some(),
            "the valid callback must be eligible before varying rejected command forms"
        );
        for command in [
            "python3 check.py".to_owned(),
            format!("{base}; echo bad"),
            format!("{base} && echo bad"),
            format!("{base} $(echo bad)"),
            format!("{base} $HOME"),
            format!("{base} *.md"),
            format!("{base} > output"),
            format!("{base}\necho bad"),
            format!("{base} `echo bad`"),
            format!("env {base}"),
            format!("python3 -c '{}'", callback_path(&script)),
            format!("python3 '{}'", callback_path(&external)),
            format!("python3 '{}/missing.py'", callback_path(root.path())),
            format!("python3 '{}'", callback_path(root.path())),
        ] {
            assert!(
                script_identity(root.path(), "Bash", &json!({"command":command})).is_none(),
                "unverifiable script must not be eligible: {command}"
            );
        }
        assert!(script_identity(root.path(), "OtherTool", &json!({"command":base})).is_none());
    }

    #[test]
    fn script_identity_requires_literal_invocation_and_bounded_regular_script() {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("check.sh");
        std::fs::write(&script, "#!/bin/sh\necho ok\n").unwrap();
        let direct = json!({"command":format!("'{}' first",callback_path(&script))});
        assert!(script_identity(root.path(), "Bash", &direct).is_some());
        let via_shell = json!({"command":format!("sh '{}' first",callback_path(&script))});
        let via_bash = json!({"command":format!("bash '{}' first",callback_path(&script))});
        assert_ne!(
            script_identity(root.path(), "Bash", &via_shell),
            script_identity(root.path(), "Bash", &via_bash),
            "changing the interpreter must not inherit the script grant"
        );
        for command in [
            format!("sh -e '{}'", callback_path(&script)),
            format!("unknown '{}'", callback_path(&script)),
            format!("sh '{}", callback_path(&script)),
            format!("sh '{}' \\escaped", callback_path(&script)),
        ] {
            assert!(script_identity(root.path(), "Bash", &json!({"command":command})).is_none());
        }
        std::fs::write(&script, "echo no shebang\n").unwrap();
        assert!(script_identity(root.path(), "Bash", &direct).is_none());
        std::fs::write(&script, vec![b'x'; 1024 * 1024 + 1]).unwrap();
        assert!(
            script_identity(root.path(), "Bash", &via_shell).is_none(),
            "oversized scripts must not create an unbounded eligibility read"
        );
    }

    #[cfg(unix)]
    #[test]
    fn script_identity_rechecks_symlink_containment_and_target() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = root.path().join("check.py");
        let link = root.path().join("link.py");
        fs::write(&target, "print('ok')\n").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let key = json!({"command":format!("python3 '{}'",callback_path(&link))});
        assert!(script_identity(root.path(), "Bash", &key).is_some());
        fs::remove_file(&link).unwrap();
        let external = outside.path().join("check.py");
        fs::write(&external, "print('ok')\n").unwrap();
        std::os::unix::fs::symlink(&external, &link).unwrap();
        assert!(
            script_identity(root.path(), "Bash", &key).is_none(),
            "a retargeted outside-project symlink must lose script eligibility"
        );
    }
}

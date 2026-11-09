// ABOUTME: Desktop binary entry point — delegates to emend_lib::run().
// ABOUTME: Suppresses the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    emend_lib::run()
}

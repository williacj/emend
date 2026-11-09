// ABOUTME: Desktop binary entry point — delegates to cowrite_lib::run().
// ABOUTME: Suppresses the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cowrite_lib::run()
}

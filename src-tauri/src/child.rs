//! Spawning the console programs this app runs.
//!
//! Tempo is a GUI process with no console of its own. Windows gives a console
//! program its own window unless it is told not to, so a bare `Command::new`
//! puts a black window in front of the user - on startup, every time, for
//! something as small as asking a version number.
//!
//! Everything that runs an external program goes through `quiet`.

use std::process::Command;

/// Runs the command without giving it a console window.
///
/// A no-op away from Windows, where the flag does not exist and the problem
/// does not either.
pub fn quiet(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// Do not allocate a console for the child.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

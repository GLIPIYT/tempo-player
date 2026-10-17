use serde::{Deserialize, Serialize};

use crate::database::Db;

const SETTINGS_KEY: &str = "soundcloud.capture_settings";
const MIN_MANUAL_BLOCKS: usize = 1;
const MAX_MANUAL_BLOCKS: usize = 12;
const MAX_AUTOMATIC_BLOCKS: usize = 8;

/// Capture preferences saved independently of the current machine resources.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSettings {
    pub automatic: bool,
    pub blocks: usize,
}

impl Default for CaptureSettings {
    fn default() -> Self {
        Self {
            automatic: true,
            blocks: MIN_MANUAL_BLOCKS,
        }
    }
}

fn normalize(settings: CaptureSettings) -> CaptureSettings {
    CaptureSettings {
        automatic: settings.automatic,
        blocks: settings.blocks.clamp(MIN_MANUAL_BLOCKS, MAX_MANUAL_BLOCKS),
    }
}

/// Reads the saved policy, using automatic mode when the setting is absent or invalid.
pub fn settings(db: &Db) -> CaptureSettings {
    match db.get_app_setting(SETTINGS_KEY) {
        Ok(Some(value)) => match serde_json::from_str::<CaptureSettings>(&value) {
            Ok(settings) => normalize(settings),
            Err(_) => save_default(db),
        },
        Ok(None) => save_default(db),
        Err(_) => CaptureSettings::default(),
    }
}

fn save_default(db: &Db) -> CaptureSettings {
    let settings = CaptureSettings::default();
    if let Ok(value) = serde_json::to_string(&settings) {
        let _ = db.set_app_setting(SETTINGS_KEY, &value);
    }
    settings
}

/// Saves a normalized capture policy in the database's app settings table.
pub fn set_settings(db: &Db, settings: CaptureSettings) -> Result<CaptureSettings, String> {
    let settings = normalize(settings);
    let value = serde_json::to_string(&settings)
        .map_err(|_| "Could not save SoundCloud capture settings.".to_string())?;
    db.set_app_setting(SETTINGS_KEY, &value)?;
    Ok(settings)
}

/// Chooses the current block count without probing system resources on the caller's thread.
pub async fn selected_blocks(db: &Db) -> usize {
    let settings = settings(db);
    if !settings.automatic {
        return settings.blocks;
    }

    tauri::async_runtime::spawn_blocking(automatic_blocks)
        .await
        .unwrap_or(1)
}

/// Reads currently available physical memory for the recorder's capture-time guard.
#[cfg(windows)]
pub fn system_available_memory() -> Option<u64> {
    windows_resources::available_memory()
}

/// Memory counters are unavailable on unsupported platforms, so callers use a safe fallback.
#[cfg(not(windows))]
pub fn system_available_memory() -> Option<u64> {
    None
}

#[cfg(not(windows))]
fn automatic_blocks() -> usize {
    1
}

#[cfg(windows)]
fn automatic_blocks() -> usize {
    let Some((logical_processors, busy_fraction)) = windows_resources::sample_cpu_load() else {
        return 1;
    };
    let Some(available_bytes) = system_available_memory() else {
        return 1;
    };

    // Avoid adding capture work when the machine is already under sustained CPU pressure.
    if busy_fraction > 0.85 {
        return 1;
    }

    // Reserve one quarter of otherwise-idle capacity for foreground work, then cap concurrency.
    let available_cpu = logical_processors as f64 * (1.0 - busy_fraction);
    let cpu_budget = (available_cpu * 0.75).floor() as usize;
    let cpu_budget = cpu_budget.clamp(1, MAX_AUTOMATIC_BLOCKS);

    // Keep 1.5 GiB free for Windows/user apps, then reserve 350 MiB for the shared browser
    // host and 128 MiB per block. The measured media footprint is lower (~50 MiB per block),
    // but this budget leaves room for browser and decoder overhead without suppressing 8 blocks
    // on ordinary machines with about 3.8 GiB currently available.
    const SYSTEM_AND_APP_RESERVE: u64 = 1536 * 1024 * 1024;
    const FIXED_HOST_OVERHEAD: u64 = 350 * 1024 * 1024;
    const MEMORY_BUDGET_PER_BLOCK: u64 = 128 * 1024 * 1024;
    let available_for_blocks = available_bytes
        .saturating_sub(SYSTEM_AND_APP_RESERVE)
        .saturating_sub(FIXED_HOST_OVERHEAD);
    let memory_budget =
        (available_for_blocks / MEMORY_BUDGET_PER_BLOCK).min(MAX_AUTOMATIC_BLOCKS as u64) as usize;
    let memory_budget = memory_budget.max(1);

    cpu_budget.min(memory_budget).clamp(1, MAX_AUTOMATIC_BLOCKS)
}

#[cfg(windows)]
mod windows_resources {
    use std::time::Duration;

    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::{
        SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX},
        Threading::{GetActiveProcessorCount, GetSystemTimes, ALL_PROCESSOR_GROUPS},
    };

    #[derive(Clone, Copy)]
    struct CpuTimes {
        idle: u64,
        kernel: u64,
        user: u64,
    }

    fn filetime_ticks(value: FILETIME) -> u64 {
        ((value.dwHighDateTime as u32 as u64) << 32) | value.dwLowDateTime as u64
    }

    fn cpu_times() -> Option<CpuTimes> {
        let mut idle = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        // SAFETY: the API fills each valid, exclusively borrowed FILETIME structure.
        unsafe {
            GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)).ok()?;
        }
        Some(CpuTimes {
            idle: filetime_ticks(idle),
            kernel: filetime_ticks(kernel),
            user: filetime_ticks(user),
        })
    }

    pub fn sample_cpu_load() -> Option<(u32, f64)> {
        let first = cpu_times()?;
        // Sampling over a short interval reflects current pressure without running on the audio actor.
        std::thread::sleep(Duration::from_millis(300));
        let second = cpu_times()?;

        let idle_delta = second.idle.checked_sub(first.idle)?;
        let kernel_delta = second.kernel.checked_sub(first.kernel)?;
        let user_delta = second.user.checked_sub(first.user)?;
        // Kernel time includes idle time; total time is kernel + user.
        let total_delta = kernel_delta.checked_add(user_delta)?;
        if total_delta == 0 || idle_delta > total_delta {
            return None;
        }
        let busy_fraction = 1.0 - idle_delta as f64 / total_delta as f64;
        // ALL_PROCESSOR_GROUPS returns the total across groups on high-core-count systems.
        let logical_processors = unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) };
        (logical_processors > 0 && busy_fraction.is_finite())
            .then_some((logical_processors, busy_fraction.clamp(0.0, 1.0)))
    }

    pub fn available_memory() -> Option<u64> {
        let mut memory = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..MEMORYSTATUSEX::default()
        };
        // SAFETY: GlobalMemoryStatusEx writes to the initialized structure above.
        unsafe { GlobalMemoryStatusEx(&mut memory) }.ok()?;
        (memory.ullAvailPhys > 0).then_some(memory.ullAvailPhys)
    }
}

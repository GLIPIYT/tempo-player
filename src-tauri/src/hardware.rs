use std::sync::OnceLock;

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareProfile {
    pub installed_ram_bytes: Option<u64>,
    pub physical_cores: Option<u32>,
    pub max_dedicated_vram_bytes: Option<u64>,
    pub recommended_enabled: bool,
}

fn recommend_analysis(ram: Option<u64>, cores: Option<u32>, vram: Option<u64>) -> bool {
    matches!(ram, Some(bytes) if bytes >= 16 * 1024 * 1024 * 1024)
        && matches!(cores, Some(count) if count >= 6)
        && matches!(vram, Some(bytes) if bytes >= 2 * 1024 * 1024 * 1024)
}

// Each tuple is (software adapter, dedicated video bytes, shared system bytes).
fn max_dedicated_vram(adapters: &[(bool, u64, u64)]) -> Option<u64> {
    adapters
        .iter()
        .filter(|adapter| !adapter.0)
        .map(|adapter| adapter.1)
        .max()
}

/// Parse the variable record stream without dereferencing its union or mask array.
/// A RelationProcessorCore record counts once regardless of SMT or processor groups.
fn parse_physical_cores(bytes: &[u8], affinity_bytes: usize) -> Option<u32> {
    if !matches!(affinity_bytes, 4 | 8) || bytes.is_empty() {
        return None;
    }
    let mut offset = 0usize;
    let mut cores = 0u32;
    while offset < bytes.len() {
        let header = bytes.get(offset..offset.checked_add(8)?)?;
        let relationship = u32::from_le_bytes(header[0..4].try_into().ok()?);
        let size = u32::from_le_bytes(header[4..8].try_into().ok()?) as usize;
        if relationship != 0 || size < 32 {
            return None;
        }
        let record = bytes.get(offset..offset.checked_add(size)?)?;
        let groups = u16::from_le_bytes(record[30..32].try_into().ok()?) as usize;
        let required = 32usize.checked_add(groups.checked_mul(affinity_bytes + 8)?)?;
        if groups == 0 || required > size {
            return None;
        }
        cores = cores.checked_add(1)?;
        offset = offset.checked_add(size)?;
    }
    Some(cores)
}

pub fn get_hardware_profile() -> HardwareProfile {
    static PROFILE: OnceLock<HardwareProfile> = OnceLock::new();
    PROFILE.get_or_init(probe_hardware).clone()
}

#[tauri::command]
pub async fn get_lyrics_analysis_hardware() -> Result<HardwareProfile, String> {
    tauri::async_runtime::spawn_blocking(get_hardware_profile)
        .await
        .map_err(|error| format!("Hardware probe failed: {error}"))
}

#[cfg(not(windows))]
fn probe_hardware() -> HardwareProfile {
    HardwareProfile {
        installed_ram_bytes: None,
        physical_cores: None,
        max_dedicated_vram_bytes: None,
        recommended_enabled: false,
    }
}

#[cfg(windows)]
fn probe_hardware() -> HardwareProfile {
    let installed_ram_bytes = windows_probe::installed_ram();
    let physical_cores = windows_probe::physical_cores();
    let max_dedicated_vram_bytes = windows_probe::dedicated_vram();
    HardwareProfile {
        installed_ram_bytes,
        physical_cores,
        max_dedicated_vram_bytes,
        recommended_enabled: recommend_analysis(
            installed_ram_bytes,
            physical_cores,
            max_dedicated_vram_bytes,
        ),
    }
}

#[cfg(windows)]
mod windows_probe {
    use super::{max_dedicated_vram, parse_physical_cores};
    use windows::Win32::{
        Foundation::ERROR_INSUFFICIENT_BUFFER,
        Graphics::Dxgi::{
            CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_ERROR_NOT_FOUND,
        },
        System::SystemInformation::{
            GetLogicalProcessorInformationEx, GetPhysicallyInstalledSystemMemory,
            RelationProcessorCore, SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX,
        },
    };

    pub fn installed_ram() -> Option<u64> {
        let mut kib = 0u64;
        // SAFETY: the API writes one u64 to a valid, exclusively borrowed local.
        unsafe { GetPhysicallyInstalledSystemMemory(&mut kib) }.ok()?;
        kib.checked_mul(1024).filter(|bytes| *bytes > 0)
    }

    pub fn physical_cores() -> Option<u32> {
        // Hotplug can grow the required buffer between size query and read.
        // Retry within this single cached probe, never periodically.
        for _ in 0..3 {
            let mut required = 0u32;
            // SAFETY: a null output is the documented buffer-size query.
            let query = unsafe {
                GetLogicalProcessorInformationEx(RelationProcessorCore, None, &mut required)
            };
            if query.err()?.code() != ERROR_INSUFFICIENT_BUFFER.to_hresult() || required == 0 {
                return None;
            }
            let capacity = required as usize;
            let word_bytes = std::mem::size_of::<usize>();
            let words = capacity.checked_add(word_bytes - 1)? / word_bytes;
            // usize storage provides the native struct's required alignment.
            let mut buffer = Vec::<usize>::new();
            buffer.try_reserve_exact(words).ok()?;
            buffer.resize(words, 0);
            // SAFETY: buffer is aligned and owns at least `required` writable bytes;
            // the API receives the capacity and cannot write past that length.
            let result = unsafe {
                GetLogicalProcessorInformationEx(
                    RelationProcessorCore,
                    Some(
                        buffer
                            .as_mut_ptr()
                            .cast::<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX>(),
                    ),
                    &mut required,
                )
            };
            if let Err(error) = result {
                if error.code() == ERROR_INSUFFICIENT_BUFFER.to_hresult() {
                    continue;
                }
                return None;
            }
            let written = required as usize;
            if written == 0 || written > capacity {
                return None;
            }
            // SAFETY: successful call initialized `written` bytes inside the owned
            // allocation; this read-only slice does not outlive that allocation.
            let bytes =
                unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), written) };
            return parse_physical_cores(bytes, word_bytes);
        }
        None
    }

    pub fn dedicated_vram() -> Option<u64> {
        // SAFETY: the windows binding manages COM interface lifetimes and outputs.
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.ok()?;
        let mut adapters = Vec::new();
        let mut index = 0u32;
        loop {
            // SAFETY: factory is valid and the binding owns each returned interface.
            let adapter = match unsafe { factory.EnumAdapters1(index) } {
                Ok(adapter) => adapter,
                Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(_) => return None,
            };
            // SAFETY: adapter is valid and the binding initializes the description.
            let description = unsafe { adapter.GetDesc1() }.ok()?;
            adapters.push((
                description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0,
                description.DedicatedVideoMemory as u64,
                description.SharedSystemMemory as u64,
            ));
            index = index.checked_add(1)?;
        }
        max_dedicated_vram(&adapters)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enables_only_at_all_three_binary_thresholds() {
        assert!(recommend_analysis(
            Some(17_179_869_184),
            Some(6),
            Some(2_147_483_648)
        ));
        assert!(!recommend_analysis(
            Some(17_179_869_183),
            Some(6),
            Some(2_147_483_648)
        ));
        assert!(!recommend_analysis(
            Some(17_179_869_184),
            Some(5),
            Some(2_147_483_648)
        ));
        assert!(!recommend_analysis(
            Some(17_179_869_184),
            Some(6),
            Some(2_147_483_647)
        ));
    }

    #[test]
    fn unknown_measurements_disable_analysis() {
        assert!(!recommend_analysis(None, Some(6), Some(2_147_483_648)));
        assert!(!recommend_analysis(
            Some(17_179_869_184),
            None,
            Some(2_147_483_648)
        ));
        assert!(!recommend_analysis(Some(17_179_869_184), Some(6), None));
    }

    #[test]
    fn never_sums_adapters_or_counts_shared_or_software_memory() {
        assert_eq!(
            max_dedicated_vram(&[(false, 1_073_741_824, 0), (false, 1_073_741_824, 0)]),
            Some(1_073_741_824)
        );
        assert_eq!(
            max_dedicated_vram(&[(false, 0, 8_589_934_592), (true, 8_589_934_592, 0)]),
            Some(0)
        );
        assert_eq!(
            max_dedicated_vram(&[(false, 1_073_741_824, 0), (false, 2_147_483_648, 0)]),
            Some(2_147_483_648)
        );
        assert_eq!(max_dedicated_vram(&[(true, 8_589_934_592, 0)]), None);
        assert_eq!(max_dedicated_vram(&[]), None);
    }

    fn core_record(groups: &[(u64, u16)], extra_bytes: usize) -> Vec<u8> {
        let size = 32 + groups.len() * 16 + extra_bytes;
        let mut bytes = vec![0; size];
        bytes[4..8].copy_from_slice(&(size as u32).to_le_bytes());
        bytes[8] = 1; // SMT: logical processors still belong to a single core.
        bytes[30..32].copy_from_slice(&(groups.len() as u16).to_le_bytes());
        for (index, (mask, group)) in groups.iter().enumerate() {
            let offset = 32 + index * 16;
            bytes[offset..offset + 8].copy_from_slice(&mask.to_le_bytes());
            bytes[offset + 8..offset + 10].copy_from_slice(&group.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn counts_variable_sized_core_records_instead_of_smt_threads_or_groups() {
        let mut bytes = core_record(&[(0b11, 0)], 0);
        bytes.extend(core_record(&[(0b11, 1)], 16));
        bytes.extend(core_record(&[(0b1111, 2), (0b11, 3)], 0));
        assert_eq!(parse_physical_cores(&bytes, 8), Some(3));
    }

    #[test]
    fn accepts_32_bit_affinity_records_without_counting_mask_bits() {
        let mut bytes = vec![0; 44];
        bytes[4..8].copy_from_slice(&44_u32.to_le_bytes());
        bytes[30..32].copy_from_slice(&1_u16.to_le_bytes());
        bytes[32..36].copy_from_slice(&0b1111_u32.to_le_bytes());
        assert_eq!(parse_physical_cores(&bytes, 4), Some(1));
    }

    #[test]
    fn rejects_truncated_zero_sized_and_invalid_records_without_panicking() {
        let full = core_record(&[(0b11, 0)], 0);
        for length in 0..full.len() {
            assert_eq!(
                parse_physical_cores(&full[..length], 8),
                None,
                "length={length}"
            );
        }
        assert_eq!(parse_physical_cores(&[0; 8], 8), None);
        assert_eq!(parse_physical_cores(&core_record(&[], 0), 8), None);
        let mut malformed = full.clone();
        malformed[30..32].copy_from_slice(&2_u16.to_le_bytes());
        assert_eq!(parse_physical_cores(&malformed, 8), None);
        let mut truncated_tail = full.clone();
        truncated_tail.extend_from_slice(&[0; 4]);
        assert_eq!(parse_physical_cores(&truncated_tail, 8), None);
        assert_eq!(parse_physical_cores(&full, 3), None);
    }
}

use anyhow::{Result, bail, ensure};
use std::{env, io, ptr};
use windows_sys::Win32::{
    Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SERVICE_DOES_NOT_EXIST, ERROR_SUCCESS,
    },
    Storage::FileSystem::GetDiskFreeSpaceExW,
    System::{Registry::*, Services::*, SystemInformation::*},
};

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

pub fn matches(kind: &str, value: &str) -> Result<bool> {
    match kind {
        "architecture" => {
            let mut info = SYSTEM_INFO::default();
            unsafe {
                GetNativeSystemInfo(&mut info);
            }
            let name = match unsafe { info.Anonymous.Anonymous.wProcessorArchitecture } {
                PROCESSOR_ARCHITECTURE_AMD64 => "AMD64",
                PROCESSOR_ARCHITECTURE_ARM64 => "ARM64",
                PROCESSOR_ARCHITECTURE_INTEL => "x86",
                _ => "unknown",
            };
            Ok(name.eq_ignore_ascii_case(value)
                || (name == "AMD64" && value.eq_ignore_ascii_case("x64")))
        }
        "memory" | "free_disk" => {
            let min_mib: u64 = value.parse()?;
            let bytes = if kind == "memory" {
                let mut memory = MEMORYSTATUSEX {
                    dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
                    ..Default::default()
                };
                if unsafe { GlobalMemoryStatusEx(&mut memory) } == 0 {
                    return Err(io::Error::last_os_error().into());
                }
                memory.ullTotalPhys
            } else {
                let path = wide(&env::var("SystemRoot")?);
                let mut free = 0;
                if unsafe {
                    GetDiskFreeSpaceExW(path.as_ptr(), &mut free, ptr::null_mut(), ptr::null_mut())
                } == 0
                {
                    return Err(io::Error::last_os_error().into());
                }
                free
            };
            Ok(bytes / (1024 * 1024) >= min_mib)
        }
        "service" | "running" => {
            let manager = unsafe { OpenSCManagerW(ptr::null(), ptr::null(), SC_MANAGER_CONNECT) };
            if manager.is_null() {
                return Err(io::Error::last_os_error().into());
            }
            let service =
                unsafe { OpenServiceW(manager, wide(value).as_ptr(), SERVICE_QUERY_STATUS) };
            let last_error = io::Error::last_os_error();
            unsafe {
                CloseServiceHandle(manager);
            }
            if service.is_null() {
                if last_error.raw_os_error() == Some(ERROR_SERVICE_DOES_NOT_EXIST as i32) {
                    return Ok(false);
                }
                return Err(last_error.into());
            }
            let mut status = SERVICE_STATUS::default();
            let ok = unsafe { QueryServiceStatus(service, &mut status) };
            let error = io::Error::last_os_error();
            unsafe {
                CloseServiceHandle(service);
            }
            if ok == 0 {
                return Err(error.into());
            }
            Ok(kind == "service" || status.dwCurrentState == SERVICE_RUNNING)
        }
        "registry" => {
            let (hive, key) = value
                .split_once('\\')
                .ok_or_else(|| anyhow::anyhow!("Registrierungsschlüssel angeben"))?;
            ensure!(!key.is_empty(), "Registrierungsschlüssel fehlt");
            let root = match hive.to_ascii_uppercase().as_str() {
                "HKLM" | "HKEY_LOCAL_MACHINE" => HKEY_LOCAL_MACHINE,
                "HKCU" | "HKEY_CURRENT_USER" => HKEY_CURRENT_USER,
                _ => bail!("Lokalen HKLM- oder HKCU-Schlüssel angeben"),
            };
            let mut handle = ptr::null_mut();
            let status =
                unsafe { RegOpenKeyExW(root, wide(key).as_ptr(), 0, KEY_QUERY_VALUE, &mut handle) };
            match status {
                ERROR_SUCCESS => {
                    unsafe {
                        RegCloseKey(handle);
                    }
                    Ok(true)
                }
                ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => Ok(false),
                other => Err(io::Error::from_raw_os_error(other as i32).into()),
            }
        }
        _ => bail!("Unbekannter Filter"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_local_windows_without_modifying_it() {
        assert!(matches("memory", "1").unwrap());
        assert!(matches("free_disk", "0").unwrap());
        assert!(matches("registry", r"HKLM\SOFTWARE\Microsoft").unwrap());
        assert!(!matches("registry", r"HKCU\Software\OpenWorksMissingKeyForTests").unwrap());
        assert!(matches("service", "RpcSs").unwrap());
        assert!(matches("running", "RpcSs").unwrap());
        assert!(!matches("service", "OpenWorksMissingServiceForTests").unwrap());
    }
}

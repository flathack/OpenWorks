use anyhow::{Result, ensure};
use std::{
    env, io,
    os::windows::process::CommandExt,
    process::Command,
    ptr,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::System::Services::*;
const NAME: &str = "OpenWorksAgent";
static STOP: AtomicBool = AtomicBool::new(false);

pub fn dispatch() -> Result<()> {
    let mut name = NAME.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let table = [
        SERVICE_TABLE_ENTRYW {
            lpServiceName: name.as_mut_ptr(),
            lpServiceProc: Some(service_main),
        },
        SERVICE_TABLE_ENTRYW::default(),
    ];
    if unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) } == 0 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(())
}

unsafe extern "system" fn control(
    code: u32,
    _event: u32,
    _data: *mut core::ffi::c_void,
    _context: *mut core::ffi::c_void,
) -> u32 {
    if code == SERVICE_CONTROL_STOP || code == SERVICE_CONTROL_SHUTDOWN {
        STOP.store(true, Ordering::Release);
    }
    0
}

unsafe extern "system" fn service_main(_argc: u32, _argv: *mut *mut u16) {
    let name = NAME.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let handle =
        unsafe { RegisterServiceCtrlHandlerExW(name.as_ptr(), Some(control), ptr::null_mut()) };
    if handle.is_null() {
        return;
    }
    let status = |state, accepted, code| {
        let status = SERVICE_STATUS {
            dwServiceType: SERVICE_WIN32_OWN_PROCESS,
            dwCurrentState: state,
            dwControlsAccepted: accepted,
            dwWin32ExitCode: code,
            ..Default::default()
        };
        unsafe {
            SetServiceStatus(handle, &status);
        }
    };
    status(
        SERVICE_RUNNING,
        SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN,
        0,
    );
    let result = worker();
    status(SERVICE_STOPPED, 0, if result.is_ok() { 0 } else { 1 });
}

fn worker() -> Result<()> {
    let exe = env::current_exe()?;
    let config = env::args_os()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("Konfiguration fehlt"))?;
    ensure!(
        std::path::Path::new(&config).is_file(),
        "Konfiguration fehlt"
    );
    let mut due = Instant::now();
    let mut child: Option<std::process::Child> = None;
    while !STOP.load(Ordering::Acquire) {
        if let Some(ref mut proc) = child {
            if proc.try_wait()?.is_some() {
                child = None;
                due = Instant::now() + Duration::from_secs(60);
            }
        } else if Instant::now() >= due {
            child = Some(
                Command::new(&exe)
                    .arg(&config)
                    .arg("poll")
                    .creation_flags(0x08000000)
                    .spawn()?,
            );
        }
        thread::sleep(Duration::from_millis(300));
    }
    // An installation already in progress can finish under the enrollment lock.
    Ok(())
}

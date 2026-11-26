use crate::progress::Progress;
use anyhow::{Result, ensure};
use std::{ffi::c_void, os::windows::ffi::OsStrExt, path::Path, ptr, sync::Mutex};
use windows_sys::Win32::System::ApplicationInstallationAndServicing::*;

struct Meter<'a, 'b> {
    progress: &'a mut Progress<'b>,
    total: i64,
    position: i64,
    per_item: i64,
    backward: bool,
}

unsafe extern "system" fn update(ctx: *mut c_void, message: u32, record: MSIHANDLE) -> i32 {
    // Windows Installer owns the record and calls us only while the handler is registered.
    let meter = unsafe { &*(ctx as *const Mutex<Meter>) };
    let Ok(mut m) = meter.lock() else { return 0 };
    let field = |n| unsafe { MsiRecordGetInteger(record, n) } as i64;
    match (message & 0xff000000) as i32 {
        INSTALLMESSAGE_ACTIONSTART => {
            m.per_item = 0;
            return 1;
        }
        INSTALLMESSAGE_ACTIONDATA => {
            let delta = m.per_item;
            m.advance(delta);
        }
        INSTALLMESSAGE_PROGRESS => match field(1) {
            0 => {
                m.total = field(2).max(0);
                m.backward = field(3) == 1;
                m.position = if m.backward { m.total } else { 0 };
                m.per_item = 0;
            }
            1 => {
                m.per_item = if field(3) == 1 { field(2).max(0) } else { 0 };
                return 1;
            }
            2 => m.advance(field(2)),
            3 => m.total += field(2).max(0),
            _ => return 1,
        },
        _ => return 0,
    }
    if m.total > 0 {
        let pct = (100 * m.position / m.total).clamp(0, 100) as u8;
        m.progress.msi(pct);
    }
    1
}
impl Meter<'_, '_> {
    fn advance(&mut self, delta: i64) {
        if self.backward {
            self.position -= delta;
        } else {
            self.position += delta;
        }
    }
}
pub fn install(file: &Path, user: bool, progress: &mut Progress) -> Result<u32> {
    let path = file
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let options = if user {
        "REBOOT=ReallySuppress ALLUSERS=2 MSIINSTALLPERUSER=1"
    } else {
        "REBOOT=ReallySuppress ALLUSERS=1"
    };
    let options = options.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let meter = Mutex::new(Meter {
        progress,
        total: 0,
        position: 0,
        per_item: 0,
        backward: false,
    });
    let filter =
        (INSTALLLOGMODE_PROGRESS | INSTALLLOGMODE_ACTIONSTART | INSTALLLOGMODE_ACTIONDATA) as u32;
    let code =
        unsafe { MsiSetExternalUIRecord(Some(update), filter, ptr::from_ref(&meter).cast(), None) };
    ensure!(code == 0, "Windows Installer Fortschrittsanzeige: {code}");
    // This short-lived worker processes one rule at a time. Remove our callback
    // before its stack context goes out of scope.
    let old = unsafe { MsiSetInternalUI(INSTALLUILEVEL_NONE, ptr::null_mut()) };
    let result = unsafe { MsiInstallProductW(path.as_ptr(), options.as_ptr()) };
    unsafe {
        MsiSetExternalUIRecord(None, 0, ptr::null(), None);
        MsiSetInternalUI(old, ptr::null_mut());
    }
    Ok(result)
}

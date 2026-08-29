/*
 * Copyright (C) 2026 David Byers dba Byers Brands
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

/// Native System Tray builder for iyou_home sovereign node.
pub fn build_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let header = MenuItem::with_id(
        app,
        "header",
        "iyou_home (Sovereign Node)",
        false,
        None::<&str>,
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let show = MenuItem::with_id(app, "show", "Show Dashboard", true, None::<&str>)?;
    let lock = MenuItem::with_id(app, "lock", "🔒 Lock Enclave", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let bridge_status = MenuItem::with_id(
        app,
        "bridge_status",
        "🟢 Signature Bridge (:9001)",
        false,
        None::<&str>,
    )?;
    let nostr_status = MenuItem::with_id(
        app,
        "nostr_status",
        "🟢 Nostr Relay (:9003)",
        false,
        None::<&str>,
    )?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit iyou_home", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &header,
            &sep1,
            &show,
            &lock,
            &sep2,
            &bridge_status,
            &nostr_status,
            &sep3,
            &quit,
        ],
    )?;

    let tray_icon = tauri::include_image!("./icons/tray-icon.png");

    let tray_builder = TrayIconBuilder::new()
        .icon(tray_icon)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "lock" => {
                let _ = app.emit("app://lock", ());
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        });

    tray_builder.build(app)?;

    Ok(())
}

/// Native macOS / desktop application menu bar.
pub fn build_app_menu(app: &tauri::App) -> Result<Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    let app_menu = SubmenuBuilder::new(app, "iyou_home")
        .about(Some(AboutMetadata {
            name: Some("iyou_home".to_string()),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            copyright: Some("Copyright (C) 2026 David Byers dba Byers Brands".to_string()),
            ..Default::default()
        }))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .fullscreen()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .close_window()
        .build()?;

    #[cfg(target_os = "macos")]
    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .build()?;

    #[cfg(not(target_os = "macos"))]
    let menu = MenuBuilder::new(app)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .build()?;

    Ok(menu)
}

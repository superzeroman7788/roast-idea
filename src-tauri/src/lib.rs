// ROAST 桌面瘦壳:webview 载 Render 上的 Web 版(frontendDist = 线上 URL),
// 大部分迭代靠 Render 部署直达,无需重发 App;原生壳本身的更新走 updater 插件(签名校验)。

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::Manager;

// 启动时静默检查原生壳更新:有新版就下载+安装+重启;无网/无更新都不打扰用户。
#[cfg(desktop)]
async fn check_update(app: tauri::AppHandle) {
  use tauri_plugin_updater::UpdaterExt;
  let updater = match app.updater() {
    Ok(u) => u,
    Err(_) => return,
  };
  if let Ok(Some(update)) = updater.check().await {
    if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
      app.restart();
    }
  }
}

// 菜单:瘦壳载的是远程 Web 版,推新版后需重新加载页面才看得到。
// 之前没有刷新入口,用户只能退出重开。这里补 ⌘R「刷新」+ 标准编辑项(否则自定义菜单会丢 copy/paste)。
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
  let reload = MenuItem::with_id(app, "reload", "刷新 · 拉取最新版", true, Some("CmdOrCtrl+R"))?;
  let app_menu = Submenu::with_items(
    app,
    "ROAST",
    true,
    &[
      &PredefinedMenuItem::about(app, None, None)?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::hide(app, None)?,
      &PredefinedMenuItem::hide_others(app, None)?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::quit(app, None)?,
    ],
  )?;
  let edit_menu = Submenu::with_items(
    app,
    "编辑",
    true,
    &[
      &PredefinedMenuItem::undo(app, None)?,
      &PredefinedMenuItem::redo(app, None)?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::cut(app, None)?,
      &PredefinedMenuItem::copy(app, None)?,
      &PredefinedMenuItem::paste(app, None)?,
      &PredefinedMenuItem::select_all(app, None)?,
    ],
  )?;
  let view_menu = Submenu::with_items(app, "视图", true, &[&reload])?;
  let window_menu = Submenu::with_items(
    app,
    "窗口",
    true,
    &[
      &PredefinedMenuItem::minimize(app, None)?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::close_window(app, None)?,
    ],
  )?;
  Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu, &window_menu])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .on_menu_event(|app, event| {
      if event.id() == "reload" {
        if let Some(w) = app.get_webview_window("main") {
          let _ = w.eval("window.location.reload()");
        }
      }
    })
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // ⌘R 刷新菜单(桌面端;移动端无菜单栏)
      #[cfg(desktop)]
      {
        let menu = build_menu(app.handle())?;
        app.set_menu(menu)?;
      }
      #[cfg(desktop)]
      {
        app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move { check_update(handle).await });
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

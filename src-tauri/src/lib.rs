// ROAST 桌面瘦壳:webview 载 Render 上的 Web 版(frontendDist = 线上 URL),
// 大部分迭代靠 Render 部署直达,无需重发 App;原生壳本身的更新走 updater 插件(签名校验)。

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
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

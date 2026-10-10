fn main() {
    // 静态链接 VC 运行时：产物不依赖目标机装了什么 CRT（桌面壳的落地自包含性）
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new().static_vc_runtime(true)),
    )
    .expect("failed to run tauri-build");
}

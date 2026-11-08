# 构建 iPad 版

Windows 不能直接生成 iPad 安装包。需要使用一台 Mac 完成最后一步签名和安装。
应用本身是 Capacitor 工程，网页、离线数据和局域网导入逻辑与 Android 版共用。

需要完整安装步骤时，另见同目录的 [苹果安装手册.md](苹果安装手册.md)。
面向 Mac 的工程包在 `ios/release/刷题助手-iPad-工程.zip`。

## 需要准备

- macOS 13 或更新版本
- Xcode 15 或更新版本
- CocoaPods
- Node.js 20 或更新版本
- Python 3.10 或更新版本（只用于构建离线网页）

## 第一次构建

1. 把整个项目文件夹复制到 Mac。
2. 安装依赖：

```bash
npm install
sudo gem install cocoapods   # 如果还没安装 CocoaPods
```

3. 构建离线网页并同步到 iOS 工程：

```bash
python3 build_offline.py
npx cap sync ios
cd ios/App
pod install
```

也可以直接在项目根目录运行 `bash ios/构建iPad版.sh`，它会完成上述步骤并打开 Xcode 工程。

4. 打开 Xcode 工程：

```bash
open App.xcworkspace
```

注意打开的是 `App.xcworkspace`，不是 `App.xcodeproj`。

5. 在 Xcode 中：

- 左侧选择 `App` target。
- 打开 **Signing & Capabilities**，选择你的 Apple Developer Team。
- 如果 Bundle Identifier 与已有项目冲突，改成自己的唯一标识，例如 `com.yourname.shuati`。
- 连接 iPad，在顶部设备列表中选择 iPad，点击 Run。

第一次运行时，iPad 会询问是否允许访问本地网络；如果要用「从电脑导入」，选择允许。

## 安装到 iPad

- **免费 Apple ID**：可以通过 Xcode 直接安装到自己的 iPad，但证书通常 7 天后失效，需要重新用 Xcode 安装。
- **付费 Apple Developer 账号**：可以使用 TestFlight 或 Ad Hoc 分发，适合长期使用和多台设备。
- 不需要上架 App Store 也可以安装。

## 题库导入

安装后有两种方式：

1. **本地文件**：电脑「导出题库」得到 JSON，传到 iPad，在 App 中导入。整个过程不需要网络。
2. **局域网导入**：电脑打开「我的题库 → 分享给平板 → 开始分享」，iPad 打开「配置题库 → 从电脑导入」，输入电脑页面显示的地址和导入码。只有导入时需要同一 Wi-Fi，刷题仍完全离线。命令行方式仍可使用 `tools/题库分享给平板.bat`。

## 后续更新网页

每次修改网页或离线逻辑后：

```bash
python3 build_offline.py
npx cap sync ios
cd ios/App
pod install
```

然后在 Xcode 中重新 Run 或 Archive。

## 说明

- `ios/App/App/public/` 是 `npx cap sync ios` 生成的网页资源，不提交到 Git。
- 应用资源随安装包一起下发，安装后不需要电脑或网络即可刷题。
- 题库和练习记录保存在 iPad 本地 WebView 存储中；卸载 App 或清除数据会丢失，建议定期导出备份。
- Android 安装包已经可以直接构建；iPad 安装包必须在 Mac 上完成签名。

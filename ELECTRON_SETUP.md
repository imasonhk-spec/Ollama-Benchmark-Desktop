# Electron 运行时安装

如果 `npm run dev` 报错：

```text
Error: Electron uninstall
```

先确认：

```powershell
Test-Path node_modules/electron/dist/electron.exe
```

如果返回 `False`，说明 Electron npm 包存在，但 Windows 运行时没有下载。

在网络受限环境下，可以使用镜像：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
node node_modules/electron/install.js
```

确认安装成功：

```powershell
Test-Path node_modules/electron/dist/electron.exe
npm exec electron -- --version
```

预期结果类似：

```text
True
v43.2.0
```

之后启动：

```powershell
npm run dev
```

`ELECTRON_MIRROR` 只影响运行时下载，不需要在每次启动应用前设置。

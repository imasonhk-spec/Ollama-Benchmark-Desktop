# 故障排查补充

## Electron 启动时报 `Electron uninstall`

这表示 npm 包已安装，但 Electron 运行时二进制没有下载到 `node_modules/electron/dist`。需要联网执行：

```powershell
npm rebuild electron --foreground-scripts
```

如果仍失败，可手动执行：

```powershell
node node_modules/electron/install.js
```

当前受限环境中如果出现 `fetch failed`，通常是 Electron 二进制镜像或网络策略问题；源码构建仍可通过，换到可访问 npm/Electron 下载源的开发机后重新执行上述命令即可。

## Electron-vite 依赖冲突

项目已固定兼容组合：

```text
electron-vite 5.x
vite 7.x
@vitejs/plugin-react 5.x
```

不要直接把 Vite 升级到 8.x，否则 electron-vite 5 可能出现 peer dependency 冲突。

# Security Policy

This project is not an official Ninebot, Segway, or 九号 product. NineCLI is an optional independent compatibility bridge. Enable vehicle control, camera, or relay remote-control features only for devices you own or are explicitly authorized to operate.

## 支持范围

只对最新主分支提供安全修复。本项目尚未完成独立第三方安全审计，不应用于人身安全、充放电硬件保护或其他安全关键控制。

## 报告漏洞

请使用 GitHub Security Advisory 私下报告，不要在公开 Issue 中附带 Token、HMAC、车辆序列号、位置、截图或日志。

## 部署底线

- 公网访问必须使用 HTTPS，并限制管理界面的可访问网络。
- 为每个部署生成独立的 Relay Token/HMAC 和 Widget Token。
- 不要将 `.env`、SQLite 数据库、APK 签名密钥、照片和车辆位置提交到 Git。
- 即使中继手机已 root，也不要默认开启系统级远控。
- 拍照、截图和其他中继远控默认全部关闭；只能对自己拥有或获得明确授权的设备开启。
- 仪表盘数据不能代替 BMS、保险丝、充电器与硬件温控保护。

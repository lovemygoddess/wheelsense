# Privacy

This is self-hosted software. The project maintainer does not centrally collect telemetry from your deployment. Depending on enabled features, your server may process vehicle serials, BMS/TPMS data, GPS tracks, relay status, device MACs, photos, screenshots, camera identifiers, and NineCLI account/session data. Optional third-party bridges and camera/map services receive data according to your configuration. Deployers control retention, access, and deletion, and must process only data they own or are authorized to handle.

WheelSense 是自托管软件。项目维护者不提供集中云服务，也不会因为你安装或运行软件而收到你的车辆数据。

## 可能处理的数据

根据启用的功能，自托管服务器可能存储：

- 车辆序列号、电池遥测、胎压与传感器 MAC；
- 行程时间、GPS 轨迹、速度和位置描述；
- 中继手机电量、网络与运行状态；
- 主动启用远控后产生的照片、截图和指令记录；
- 可选第三方集成所需的账号会话或 API 凭证。

GPS 轨迹、照片和账号信息应视为高敏感数据。默认不开启中继远控。

## 手机权限

- 蓝牙与附近设备：连接 BMS 和扫描传感器。
- 位置：Android 蓝牙扫描兼容和主动使用的 GPS 测速/轨迹功能。
- 相机：仅用于所有者主动启用的中继拍照功能。
- 安装应用：用于用户发起的 APK 更新。

## 自托管者责任

部署者是其服务器中数据的控制者，应负责设置强密码、HTTPS、访问控制、备份与删除期限。如果为他人提供部署，必须根据当地法律提供适用的隐私告知并获得所需同意。

不要在 GitHub Issue、截图、日志或测试数据中公开真实轨迹、序列号、MAC、照片、Token 或账号信息。

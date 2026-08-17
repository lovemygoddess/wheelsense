# 配置说明

## 必填项

| 配置 | 用途 |
| --- | --- |
| `APP_KEY` | Laravel 加密密钥，用 `php artisan key:generate` 生成 |
| `BMS_RELAY_TOKEN` | 中继 Bearer 身份凭证 |
| `BMS_RELAY_HMAC_SECRET` | 中继请求体签名密钥 |
| 仪表盘密码 | 用 `php artisan evtelemetry:set-dashboard-password` 设置 |

Token 和 HMAC 必须成对轮换。可先填写 `*_NEXT` 容忍新旧中继，完成升级后立即删除旧对。

## 中继远控

`ENABLE_RELAY_REMOTE_CONTROL=false` 时，服务端拒绝所有中继指令，包括拍照、截图和固件更新。即使开启远控，`ENABLE_DANGEROUS_RELAY_COMMANDS=false` 仍会额外拒绝重启、关机、模拟按键/滑动、清队列与自更新等高风险命令。只能对自己拥有或获得明确授权的设备开启。

## NineCLI 兼容桥接

`NINECLI_BASE_URL` 指向一个提供本项目预期 REST 接口的独立服务。该组件不包含在本仓库，也不是 Ninebot 官方 API。不配置时请把仪表盘视为 BMS 为主的离线仪表。

## TPMS

前后轮传感器 MAC 分别填入 `TPMS_FRONT_MAC` 和 `TPMS_REAR_MAC`；仓库不提供任何真实设备标识。当前受支持的 JH 0x1E01 manufacturer frame 使用固定校验 `byte0 + byte1 + byte2 = 224`，其中 `byte0` 解为温度（`byte0 - 40` °C），`byte1` 解为压力（`byte1 × 0.02` bar）。服务端只接受校验通过的帧，并在超过 freshness 窗口后标记 `stale`。目标设备的广播格式应先用可信仪器验证，不要把这套公式套用于其它传感器。

Relay 版本比较使用 heartbeat 的 `app_ver` 与服务器侧 release metadata；未知版本不会自动推导或触发更新。

## APK 更新文件

- 中继：`storage/app/bms-relay-latest.apk`
- 仪表盘：`storage/app/dashboard-latest.apk`

中继版本比较不从 APK 文件名猜测版本。部署者可以在中继 APK 旁放置
`storage/app/bms-relay-latest.json`，填写 `version_name`、`version_code`、
`release_notes` 等发布元数据；没有元数据时，服务端会返回未知版本，Dashboard
不会把未知版本误判为可更新。示例（不含真实地址、设备标识或凭证）：

```json
{"version_name":"1.0.0","version_code":1,"release_notes":"Example release"}
```

Docker 部署对应主机目录为 `data/storage/app/`。应用覆盖安装必须保持 application ID 和签名证书不变，版本号必须递增。

## 运行注意

当前代码有少量安全参数为运行时 `env()` 读取，不要执行 `php artisan config:cache`。可以使用 `route:cache` 和 `view:cache`。

# Third-Party Notices

WheelSense 的自有代码按仓库根目录的 MIT License 发布。下列组件和它们的转传依赖仍由各自权利人按各自许可证授权：

| 组件 | 主要许可证 | 上游 |
| --- | --- | --- |
| Laravel Framework | MIT | https://github.com/laravel/framework |
| React / React Native | MIT | https://github.com/facebook/react / https://github.com/facebook/react-native |
| Expo SDK / Expo Router | MIT | https://github.com/expo/expo |
| AndroidX | Apache-2.0 | https://android.googlesource.com/platform/frameworks/support |
| Ionicons / Expo Vector Icons | MIT | https://github.com/ionic-team/ionicons |
| Gradle Wrapper | Apache-2.0 | https://github.com/gradle/gradle |
| syssi/esphome-ant-bms（协议字段参考） | Apache-2.0 | https://github.com/syssi/esphome-ant-bms |
| Anime Theme 01 Chii artwork | MIT exception; see asset notice | `apps/dashboard/assets/themes/anime-01/NOTICE.md` |

`apps/dashboard/package-lock.json` 和 `server/composer.lock` 锁定了完整依赖版本。Node 工具链还包含 Apache-2.0、BSD、ISC、MPL-2.0、CC-BY-4.0、0BSD、BlueOak-1.0.0 等许可证的转传依赖。本仓库不提交 `node_modules` 或 Composer `vendor`。

仪表盘目录中的 `EXPO-LICENSE.txt` 保留了 Expo 模板许可声明。二进制发布者应在每次发布前根据当时的 lockfile 重新生成完整的第三方许可清单，并将必需的许可文本与归属声明随 APK/容器镜像一同提供。

`apps/dashboard/src/antBmsProtocol.ts` 的帧结构和部分字段偏移对照了 `syssi/esphome-ant-bms`，并为本项目以 TypeScript 重新实现和修改。其 Apache-2.0 许可证副本见 [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)。

Segway、Ninebot 及其他第三方商标归各自权利人所有。在文档和界面中提及它们仅为说明兼容对象，不表示授权、背书或合作。

Anime Theme 01 的角色图像是 AI 生成、描绘或受 *Chobits* 中 Chii 启发的粉丝素材，不属于本仓库 MIT 代码许可，也不是 Ninebot/Segway 或相关作品权利人的官方素材。该 MIT 例外同时适用于 `apps/dashboard/assets/themes/anime-01/chii-hero.png` 与 `apps/dashboard/android/app/src/main/res/drawable-nodpi/chii_hero.png`。底层角色、作品及相关受保护元素的权利仍归各自权利人所有；本仓库不授予任何相关权利。请仅在获得相应许可的范围内使用；移除这些可选素材后，应用代码仍可构建和运行。

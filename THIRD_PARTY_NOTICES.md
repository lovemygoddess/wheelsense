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
| Anime Theme 01 original character artwork | See asset notice; not part of MIT code license | `apps/dashboard/assets/themes/anime-01/NOTICE.md` |

`apps/dashboard/package-lock.json` 和 `server/composer.lock` 锁定了完整依赖版本。Node 工具链还包含 Apache-2.0、BSD、ISC、MPL-2.0、CC-BY-4.0、0BSD、BlueOak-1.0.0 等许可证的转传依赖。本仓库不提交 `node_modules` 或 Composer `vendor`。

仪表盘目录中的 `EXPO-LICENSE.txt` 保留了 Expo 模板许可声明。二进制发布者应在每次发布前根据当时的 lockfile 重新生成完整的第三方许可清单，并将必需的许可文本与归属声明随 APK/容器镜像一同提供。

`apps/dashboard/src/antBmsProtocol.ts` 的帧结构和部分字段偏移对照了 `syssi/esphome-ant-bms`，并为本项目以 TypeScript 重新实现和修改。其 Apache-2.0 许可证副本见 [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)。

Segway、Ninebot 及其他第三方商标归各自权利人所有。在文档和界面中提及它们仅为说明兼容对象，不表示授权、背书或合作。

Anime Theme 01 使用为 WheelSense 项目提供的原创角色图像。图像作为可选主题资源分发，不属于 MIT 代码许可范围；本说明不作超出本仓库现有权利信息的权利主张，也不授予所有权、排他权、公共领域地位或其他底层作品权利。该资源的说明适用于 `apps/dashboard/assets/themes/anime-01/original-heroine.png` 与 `apps/dashboard/android/app/src/main/res/drawable-nodpi/original_heroine.png`。移除这些可选素材后，应用代码仍可构建和运行。

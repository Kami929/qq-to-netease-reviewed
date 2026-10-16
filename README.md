# QQ 音乐 → 网易云音乐“我喜欢的音乐”

这是独立编写的 Node.js 命令行脚本。参考 ToQQMusic 的“逐首搜索、人工选择、保存断点”流程，没有复制原项目代码。

## 项目状态

实验性命令行工具。离线模拟测试已通过；真实账号的搜索、扫码、添加喜欢以及 QQ 分页读取仍需联网验证，暂不保证可用性。

依赖非官方接口，平台变更可能使功能失效。接口请求错误会停止，不会被当作“没有这首歌”。仓库不包含个人歌单、登录凭据或迁移记录。

## 功能

1. 从 QQ 公开歌单链接分页读取，或读取 JSON / UTF-8 文本清单。
2. 在网易云搜索15个候选，逐首由你选择；没有自动选择第一条的行为。
3. 对歌名、歌手集合、专辑、时长差异做提示。译名/艺名也可能触发提示，需人工判断，提示不是音频鉴定结果。
4. 审核只写本地 review.json，不添加喜欢。随时 q 退出，下次继续。
5. 正式执行时扫码登录，显示账号与待新增数量，再要求输入确认语句。
6. 先备份原喜欢ID，只添加已审核歌曲；跳过已有喜欢与重复目标ID，不取消喜欢、不删歌单。
7. 每首写入后从服务器核实红心；超时或未确认则记录 unknown 并停止。重跑时以服务器当前列表为准，避免重复添加。

注意：给出的搜索候选最多15条，没找到可用 r 改关键词。不能因为搜索未出现，就断言网易云全站没有该歌曲。新喜欢通常显示在列表最前，脚本按源顺序倒序写入；平台最终排序不作保证，原有喜欢也不会被移到新位置。

## 环境与安装

需要 Node.js 22 或更新版本。下载并解压仓库后，在项目目录中打开终端：

```powershell
npm install --ignore-scripts
```

只依赖 `@neteasecloudmusicapienhanced/api`，固定版本4.41.1。npm安装产生的 package-lock.json 应保留，后续可用 npm ci --ignore-scripts 复现依赖。使用上游接口模块，不启动网页服务器，也不使用公共第三方API中转站。登录凭据会交给本机第三方接口组件，用于向网易云发请求；请先审核源码和依赖再安装使用。依赖的间接版本仍由首次安装生成的锁文件确定。

## 使用已有清单（推荐从这里开始）

创建 input 文件夹，将自己的 UTF-8 清单保存为 input/songs.txt，每行格式为 `歌曲名 - 歌手`。也支持 QQ 的“复制歌曲信息”文本和 JSON 歌曲数组。将下面的 100 改为源歌单的实际总数；无需依赖即可生成本地计划：

```powershell
node migrate.cjs prepare --source input/songs.txt --expected 100
```

会创建 review.json 和 review.json.md。若同名审核文件已存在，程序拒绝覆盖；换文件名用 `--plan another-review.json`。

安装依赖后开始搜索和人工选择：

```powershell
node migrate.cjs review
```

输入候选序号表示确认；`s` 跳过；`r` 换关键词重新搜索；`q` 保存退出。退出或出错后重跑同一命令继续，不会丢失已确认项。

要重新审核已确认/跳过的歌曲：

```powershell
node migrate.cjs review --revisit
```

更新中文报告：

```powershell
node migrate.cjs report
```

审核JSON中仅 `status: approved` 且有有效 `selected.id` 的条目会被写入。不要随意修改源数据；源数据校验失败时需新建计划。

## 可选：重新读取QQ公开歌单

```powershell
node migrate.cjs fetch-qq --url "替换为你的QQ公开歌单链接" --expected 100 --plan fresh-review.json
node migrate.cjs review --plan fresh-review.json
```

不读取QQ登录凭据，私密歌单可能无法读取。不会修改隐私设置。接口过滤歌曲或数量不足时，计划保留实际读取数量和过滤ID供核对，不会补造缺失项。分页读取尚未在线验证；请核对源平台总数与实际读取数量。

## 正式加入喜欢：需要明确执行

默认预演完全离线：

```powershell
node migrate.cjs apply
```

确认审核结果后才运行：

```powershell
node migrate.cjs apply --execute
```

程序生成 migration-records/login-qr.png，手动打开，用网易云音乐手机App扫码确认。终端输入不包含密码或验证码。Cookie仅用于本次进程，不由本脚本写入文件；下次重跑重新扫码。上游组件自身可能维护匿名设备缓存。

程序显示账号昵称、UID、原喜欢数量、待新增数量。按屏幕要求输入 `ADD 账号UID 数量` 才会写入；直接回车不执行。已跳过/未审核项不会被导入，程序可以只迁移审核完成的部分。

每次执行生成单独记录目录：

- before.json：执行前原有喜欢ID快照。
- result.json：原已喜欢、每首尝试/核实状态、最终缺失ID。

若状态 unknown，不能据此认定写入失败或成功。重新运行 apply --execute，程序先重新读取服务器喜欢列表，然后仅添加尚未存在的目标。不要因某首失败而重复跑官方整单导入。

## 测试

```powershell
node --test tests.cjs
```

测试使用模拟接口，不访问网易云、不写真实账号；覆盖默认不写入、确认拒绝、重复去重、保留原喜欢、写入超时、核验失败、断点恢复及人工审核阶段不写入。

## 参考来源

- 工作流程参考：https://github.com/alex3236/ToQQMusic （GPL-3.0；已归档；未复制其实现）
- 网易云接口组件：https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced （MIT；查看其安装说明及许可证）
- QQ只读接口参数参考：https://github.com/l-1124/qqmusicapi/blob/main/qqmusic_api/modules/songlist.py

只迁移歌曲标识和喜欢状态，不下载音频，不改变会员权限，不保证网易云收录了QQ上的每个版本。

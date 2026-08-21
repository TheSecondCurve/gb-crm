## 本项目主要功能和目的

建立闪光团队的客户信息管理系统和运营流程系统。

## 核心实体设计

### 团队成员和本项目用户表

- 账户名
- 昵称
- 真实姓名
- 电话
- 个人微信
- 角色：管理员，团队运营，兼职助手
- 备注
- 密码等必要信息
- 状态：失效，有效

### 渠道资产

管理内容和对客渠道，主要是不同渠道的账号等。

- 参考飞书表格：https://ghy685ffir.feishu.cn/wiki/QTd7wwFuCiRQwckp61xcbVGAnMg?fromScene=spaceOverview&table=tblx3PGzNONP3Ugk&view=vewvsI7T2u
- 关联团队成员

### 产品目录

- 参考飞书表格：https://ghy685ffir.feishu.cn/wiki/QTd7wwFuCiRQwckp61xcbVGAnMg?fromScene=spaceOverview&table=tblljYU2iuLOOb5F&view=vew3yJsG17

### 客户信息

- 参考：https://ghy685ffir.feishu.cn/wiki/QTd7wwFuCiRQwckp61xcbVGAnMg?fromScene=spaceOverview&table=tblvKLGIHObVQ3dV&view=vewAccSB4W
- 未来要关联微信小程序用户的其他信息，多建立一个字段 wechat openid

## 基础信息维护功能

- 上面基本信息的增删改查功能，基础信息维护要求方便，因此表格要可以像 Excel 一样直接操作最好。
- 系统内保留创建时间戳，最后修改时间戳和创建人、最后修改人
- 信息分页展示，每页展示 25 条记录，可修改
- 搜索支持模糊搜索，快速定位

## 其他功能

- 用环境变量设置一个管理员用户名和管理员密码
- Agent / 本机脚本可用个人令牌调 REST（无需克隆仓库）。签发：`curl -fsSL http://<crm-host>/agent/login.sh | sh`。只读与读写两档，仍受系统角色约束。设计见 `docs/design.md` K35，用法见 `docs/dev.md`。 


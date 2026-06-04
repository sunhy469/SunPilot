# Fixture Echo Skill

## 能力

返回输入消息，并写入一个 JSON artifact。

## 适用场景

用于验证 SunPilot Skill 扫描、manifest 校验、执行、事件和产物链路。

## 输入

`message`：需要回显的文本。

## 输出

`message` 和 `echoedAt`。

## 权限

不需要文件、网络、环境变量或 shell 权限。

## 风险

低风险。产物写入通过 daemon 的 artifact API 完成。

## 示例

输入：`{"message":"hello"}`

输出：`{"message":"hello","echoedAt":"2026-06-04T00:00:00.000Z"}`

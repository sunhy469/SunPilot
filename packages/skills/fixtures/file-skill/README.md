# Fixture File Skill

## 能力

尝试通过 `SkillContext.files` 写入一个未授权路径。

## 适用场景

只用于测试文件权限闸门。

## 输入

`path` 和 `content`。

## 输出

`ok`：布尔值。

## 权限

不声明文件写权限。

## 风险

高风险。该 Skill 应被 daemon 拒绝写文件。

## 示例

输入：`{"path":"/tmp/sunpilot-denied.txt","content":"denied"}`

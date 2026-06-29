import { useState, useMemo } from "react";
import { Card, Form, Input, Select, Button, message } from "antd";
import { PlusOutlined, SmileOutlined } from "@ant-design/icons";
import type { createRequest } from "../../../shared/api/client";
import { createDigitalBeing } from "../api";
import type { WorldNodeData } from "../types";
import "./CreateFirstBeing.scss";

interface CreateFirstBeingProps {
  nodes: WorldNodeData[];
  request: ReturnType<typeof createRequest>;
  onCreated: () => void;
}

const NODE_NAME_MAP: Record<string, string> = {
  home: "家 (Home)",
  video_workstation: "视频工作台",
  artifact_box: "产物箱",
  tiktok_station: "TikTok 发布台",
  material_library: "素材库",
  crossroad: "主路口",
  log_station: "日志/状态区",
};

export function CreateFirstBeing({ nodes, request, onCreated }: CreateFirstBeingProps) {
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();

  const homeNodeOptions = useMemo(
    () =>
      nodes.map((node) => ({
        value: node.id,
        label: NODE_NAME_MAP[node.id] ?? node.name ?? node.id,
      })),
    [nodes],
  );

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setLoading(true);
      await createDigitalBeing(request, {
        name: values.name?.trim() || "SunPilot",
        homeNodeId: values.homeNodeId ?? "home",
        description: values.description?.trim() || undefined,
      });
      message.success("数字生命已创建！");
      onCreated();
    } catch (err) {
      // Validation error from antd Form — don't show extra message
      if (err && typeof err === "object" && "errorFields" in err) return;
      message.error("创建失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="create-first-being">
      <div className="create-first-being__backdrop" />
      <Card className="create-first-being__card" bordered={false}>
        <div className="create-first-being__header">
          <SmileOutlined className="create-first-being__header-icon" />
          <h2 className="create-first-being__title">欢迎来到数字世界</h2>
          <p className="create-first-being__subtitle">
            世界已经就绪，创建一个数字生命来开始探索吧
          </p>
        </div>

        <Form
          form={form}
          layout="vertical"
          initialValues={{ name: "SunPilot", homeNodeId: "home" }}
          onFinish={handleSubmit}
        >
          <Form.Item
            name="name"
            label="名称"
            rules={[
              { required: true, message: "请输入数字生命名称" },
              { max: 32, message: "名称不能超过 32 个字符" },
            ]}
          >
            <Input placeholder="给你的数字生命起个名字" maxLength={32} />
          </Form.Item>

          <Form.Item
            name="description"
            label="描述（可选）"
            rules={[{ max: 200, message: "描述不能超过 200 个字符" }]}
          >
            <Input.TextArea
              placeholder="简单描述一下这个数字生命…"
              maxLength={200}
              rows={2}
            />
          </Form.Item>

          <Form.Item
            name="homeNodeId"
            label="出生点"
            rules={[{ required: true, message: "请选择出生点" }]}
          >
            <Select options={homeNodeOptions} />
          </Form.Item>

          <Form.Item style={{ marginBottom: 0 }}>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              icon={<PlusOutlined />}
              block
              size="large"
            >
              创建数字生命
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}

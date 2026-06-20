import { Card, Button, List, Typography, Descriptions, Space } from "antd";
import { CloseOutlined, FileTextOutlined } from "@ant-design/icons";
import type {
  AgentArtifactPreview,
  AgentArtifactSelection,
} from "../../hooks/useChat";
import "./ArtifactPanel.scss";

const { Text, Paragraph } = Typography;

interface ArtifactPanelProps {
  artifacts: AgentArtifactPreview[];
  selected: AgentArtifactSelection | null;
  onOpen: (artifactId: string) => void;
  onClose: () => void;
}

export function ArtifactPanel({
  artifacts,
  selected,
  onOpen,
  onClose,
}: ArtifactPanelProps) {
  if (artifacts.length === 0) return null;

  return (
    <div className="artifact-panel">
      <List
        size="small"
        className="artifact-panel__list"
        dataSource={artifacts}
        renderItem={(artifact) => (
          <List.Item
            actions={[
              <Button
                key="open"
                type="link"
                size="small"
                onClick={() => onOpen(artifact.id)}
              >
                查看
              </Button>
            ]}
          >
            <List.Item.Meta
              avatar={<FileTextOutlined />}
              title={artifact.name}
              description={
                <Text type="secondary">
                  {artifact.type ?? "artifact"}
                  {artifact.version ? ` v${artifact.version}` : ""}
                </Text>
              }
            />
          </List.Item>
        )}
      />
      {selected && (
        <Card
          className="artifact-panel__detail"
          title={selected.artifact.name}
          extra={
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined />}
              onClick={onClose}
              aria-label="Close artifact"
            />
          }
        >
          <Descriptions size="small" column={1}>
            <Descriptions.Item label="类型">{selected.artifact.type}</Descriptions.Item>
            {selected.artifact.version && (
              <Descriptions.Item label="版本">v{selected.artifact.version}</Descriptions.Item>
            )}
          </Descriptions>
          <Paragraph>
            <pre className="artifact-panel__content">{selected.content}</pre>
          </Paragraph>
        </Card>
      )}
    </div>
  );
}

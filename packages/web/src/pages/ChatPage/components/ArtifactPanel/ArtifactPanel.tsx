import { Card, Button, Flex, Typography, Descriptions } from "antd";
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
      <Flex vertical className="artifact-panel__list">
        {artifacts.map((artifact) => (
          <Flex key={artifact.id} align="center" gap={10} className="artifact-panel__item">
            <FileTextOutlined />
            <Flex vertical style={{ minWidth: 0, flex: 1 }}>
              <Text ellipsis>{artifact.name}</Text>
              <Text type="secondary">
                {artifact.type ?? "artifact"}
                {artifact.version ? ` v${artifact.version}` : ""}
              </Text>
            </Flex>
            <Button type="link" size="small" onClick={() => onOpen(artifact.id)}>
              查看
            </Button>
          </Flex>
        ))}
      </Flex>
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

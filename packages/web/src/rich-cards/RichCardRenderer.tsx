import { Component, memo, type ReactNode } from "react";
import { Flex, Typography, Alert, Card } from "antd";
import type { RichCardView, RichCardAction, RichCardRendererProps } from "./types";
import { CARD_REGISTRY } from "./registry";
import { InfoCard } from "./components/BasicCards";
import "./rich-cards.css";

const { Text } = Typography;

// ── Per-card Error Boundary ───────────────────────────────────────────

interface ErrorBoundaryState {
  hasError: boolean;
}

class CardErrorBoundary extends Component<
  { cardId: string; children: ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { cardId: string; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error(
      `[RichCard] "${this.props.cardId}" render failed:`,
      error,
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <Card size="small">
          <Alert type="error" showIcon message="卡片渲染失败" />
        </Card>
      );
    }
    return this.props.children;
  }
}

// ── RichCard (memoized, error-bounded, data-attributed) ─────────────

const RichCard = memo(function RichCard({
  card,
  cardState,
  onAction,
}: {
  card: RichCardView;
  cardState?: unknown;
  onAction?: (action: RichCardAction) => void;
}) {
  const render = CARD_REGISTRY[card.type];
  const actionHandler = onAction
    ? (action: { type: string; cardId?: string; itemId?: string; checked?: boolean; payload?: Record<string, unknown> }) => {
        onAction({
          ...action,
          cardId: card.id,
        } as RichCardAction);
      }
    : undefined;

  return (
    <CardErrorBoundary cardId={card.id}>
      <div
        className="rich-card-wrapper"
        data-card-type={card.type}
        data-card-id={card.id}
      >
        {render
          ? render(card, cardState, actionHandler)
          : <InfoCard title={card.title} data={{ text: `未知卡片类型: ${card.type}` }} />}
      </div>
    </CardErrorBoundary>
  );
});

// ── RichCardRenderer (public) ───────────────────────────────────────

export const RichCardRenderer = memo(function RichCardRenderer({
  cards,
  stateByCardId,
  onAction,
}: RichCardRendererProps) {
  if (!cards || cards.length === 0) return null;

  return (
    <Flex vertical gap={12} className="rich-cards-stack">
      {cards.map((card, index) => {
        const cardKey = card.id || `${card.type}_${index}`;
        const normalizedCard: RichCardView = card.id
          ? card
          : { ...card, id: cardKey };
        return (
          <RichCard
            key={cardKey}
            card={normalizedCard}
            cardState={stateByCardId?.[normalizedCard.id]}
            onAction={onAction}
          />
        );
      })}
    </Flex>
  );
});

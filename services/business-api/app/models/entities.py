from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, relationship, mapped_column

from app.models.base import Base, TimestampMixin, generate_id, utcnow


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(32), default="admin", nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    platform_accounts: Mapped[list["PlatformAccount"]] = relationship(back_populates="user")
    conversations: Mapped[list["Conversation"]] = relationship(back_populates="user")
    rpa_nodes: Mapped[list["RpaNode"]] = relationship(back_populates="user")
    rpa_events: Mapped[list["RpaEvent"]] = relationship(back_populates="user")
    rpa_tasks: Mapped[list["RpaTask"]] = relationship(back_populates="user")
    robots: Mapped[list["Robot"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    ai_provider_configs: Mapped[list["AiProviderConfig"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    settings: Mapped["UserSettings | None"] = relationship(
        back_populates="user", cascade="all, delete-orphan", uselist=False
    )
    email_provider_configs: Mapped[list["EmailProviderConfig"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    email_templates: Mapped[list["EmailTemplate"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    conversation_workflows: Mapped[list["ConversationWorkflow"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    email_send_tasks: Mapped[list["EmailSendTask"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    automation_reply_runs: Mapped[list["AutomationReplyRun"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    customer_orders: Mapped[list["CustomerOrder"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    customer_outreach_runs: Mapped[list["CustomerOutreachRun"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class AiProviderConfig(Base, TimestampMixin):
    __tablename__ = "ai_provider_configs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), unique=True, index=True, nullable=False)
    provider: Mapped[str] = mapped_column(String(32), default="deepseek", nullable=False)
    base_url: Mapped[str] = mapped_column(String(512), default="https://api.deepseek.com", nullable=False)
    model: Mapped[str] = mapped_column(String(128), default="deepseek-chat", nullable=False)
    api_key: Mapped[str] = mapped_column(Text, default="", nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    temperature: Mapped[float] = mapped_column(default=0.2, nullable=False)

    user: Mapped["User"] = relationship(back_populates="ai_provider_configs")


class UserSettings(Base, TimestampMixin):
    __tablename__ = "user_settings"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), unique=True, index=True, nullable=False)
    auto_reply_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    user: Mapped["User"] = relationship(back_populates="settings")


class EmailProviderConfig(Base, TimestampMixin):
    __tablename__ = "email_provider_configs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), unique=True, index=True, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    provider: Mapped[str] = mapped_column(String(32), default="qq", nullable=False)
    sender_email: Mapped[str] = mapped_column(String(320), default="", nullable=False)
    smtp_host: Mapped[str] = mapped_column(String(255), default="smtp.qq.com", nullable=False)
    smtp_port: Mapped[int] = mapped_column(Integer, default=465, nullable=False)
    security: Mapped[str] = mapped_column(String(32), default="ssl", nullable=False)
    auth_secret_encrypted: Mapped[str] = mapped_column(Text, default="", nullable=False)
    trigger_scenarios: Mapped[str] = mapped_column(Text, default="", nullable=False)
    ask_email_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    success_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    missing_template_text: Mapped[str] = mapped_column(Text, default="", nullable=False)

    user: Mapped["User"] = relationship(back_populates="email_provider_configs")


class EmailTemplate(Base, TimestampMixin):
    __tablename__ = "email_templates"
    __table_args__ = (
        UniqueConstraint("user_id", "template_key", name="uq_email_template_user_key"),
        UniqueConstraint("user_id", "platform_account_id", name="uq_email_template_user_platform_account"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    template_key: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    scene: Mapped[str] = mapped_column(String(64), default="store_view_link", nullable=False)
    aliases: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    subject: Mapped[str] = mapped_column(String(256), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    platform_account_id: Mapped[str | None] = mapped_column(
        ForeignKey("platform_accounts.id", ondelete="SET NULL"), index=True, nullable=True
    )

    user: Mapped["User"] = relationship(back_populates="email_templates")
    platform_account: Mapped["PlatformAccount | None"] = relationship()
    workflows: Mapped[list["ConversationWorkflow"]] = relationship(back_populates="template")
    send_tasks: Mapped[list["EmailSendTask"]] = relationship(back_populates="template")


class Robot(Base, TimestampMixin):
    __tablename__ = "robots"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="offline", nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    config_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    user: Mapped["User"] = relationship(back_populates="robots")
    qa_knowledge_bases: Mapped[list["RobotQaKnowledgeBase"]] = relationship(
        back_populates="robot", cascade="all, delete-orphan"
    )
    product_knowledge_bases: Mapped[list["RobotProductKnowledgeBase"]] = relationship(
        back_populates="robot", cascade="all, delete-orphan"
    )
    tone_knowledge_base: Mapped["RobotToneKnowledgeBase | None"] = relationship(
        back_populates="robot", cascade="all, delete-orphan", uselist=False
    )
    platform_scopes: Mapped[list["RobotPlatformScope"]] = relationship(
        back_populates="robot", cascade="all, delete-orphan"
    )
    automation_reply_runs: Mapped[list["AutomationReplyRun"]] = relationship(
        back_populates="robot", cascade="all, delete-orphan"
    )
    customer_outreach_runs: Mapped[list["CustomerOutreachRun"]] = relationship(
        back_populates="robot", cascade="all, delete-orphan"
    )


class RobotQaKnowledgeBase(Base, TimestampMixin):
    __tablename__ = "robot_qa_knowledge_bases"
    __table_args__ = (UniqueConstraint("robot_id", "knowledge_base_id", name="uq_robot_qa_kb"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    robot_id: Mapped[str] = mapped_column(ForeignKey("robots.id", ondelete="CASCADE"), index=True, nullable=False)
    knowledge_base_id: Mapped[str] = mapped_column(String(128), index=True, nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    robot: Mapped["Robot"] = relationship(back_populates="qa_knowledge_bases")


class RobotProductKnowledgeBase(Base, TimestampMixin):
    __tablename__ = "robot_product_knowledge_bases"
    __table_args__ = (UniqueConstraint("robot_id", "knowledge_base_id", name="uq_robot_product_kb"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    robot_id: Mapped[str] = mapped_column(ForeignKey("robots.id", ondelete="CASCADE"), index=True, nullable=False)
    knowledge_base_id: Mapped[str] = mapped_column(String(128), index=True, nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    robot: Mapped["Robot"] = relationship(back_populates="product_knowledge_bases")


class RobotToneKnowledgeBase(Base, TimestampMixin):
    __tablename__ = "robot_tone_knowledge_bases"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    robot_id: Mapped[str] = mapped_column(
        ForeignKey("robots.id", ondelete="CASCADE"), index=True, unique=True, nullable=False
    )
    knowledge_base_id: Mapped[str] = mapped_column(String(128), index=True, nullable=False)

    robot: Mapped["Robot"] = relationship(back_populates="tone_knowledge_base")


class RobotPlatformScope(Base, TimestampMixin):
    __tablename__ = "robot_platform_scopes"
    __table_args__ = (
        UniqueConstraint(
            "robot_id", "platform_code", "platform_account_id", "all_accounts",
            name="uq_robot_platform_scope",
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    robot_id: Mapped[str] = mapped_column(ForeignKey("robots.id", ondelete="CASCADE"), index=True, nullable=False)
    platform_code: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    platform_account_id: Mapped[str | None] = mapped_column(
        ForeignKey("platform_accounts.id", ondelete="CASCADE"), index=True, nullable=True
    )
    all_accounts: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    robot: Mapped["Robot"] = relationship(back_populates="platform_scopes")
    platform_account: Mapped["PlatformAccount | None"] = relationship(back_populates="robot_scopes")


class PlatformAccount(Base, TimestampMixin):
    __tablename__ = "platform_accounts"
    __table_args__ = (
        Index(
            "uq_platform_accounts_user_platform_local",
            "user_id",
            "platform_code",
            "local_account_id",
            unique=True,
        ),
        Index(
            "uq_platform_accounts_user_platform_external",
            "user_id",
            "platform_code",
            "external_account_id",
            unique=True,
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    platform_code: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    platform_name: Mapped[str] = mapped_column(String(64), nullable=False)
    local_account_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    external_account_id: Mapped[str | None] = mapped_column(String(128), index=True, nullable=True)
    account_name: Mapped[str] = mapped_column(String(128), nullable=False)
    account_alias: Mapped[str | None] = mapped_column(String(128), nullable=True)
    name_source: Mapped[str] = mapped_column(String(32), default="manual", nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    login_status: Mapped[str] = mapped_column(String(32), default="unknown", nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_rpa_node_id: Mapped[str | None] = mapped_column(
        ForeignKey("rpa_nodes.id"), index=True, nullable=True
    )
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    user: Mapped["User"] = relationship(back_populates="platform_accounts")
    conversations: Mapped[list["Conversation"]] = relationship(back_populates="platform_account")
    events: Mapped[list["RpaEvent"]] = relationship(back_populates="platform_account")
    tasks: Mapped[list["RpaTask"]] = relationship(back_populates="platform_account")
    robot_scopes: Mapped[list["RobotPlatformScope"]] = relationship(back_populates="platform_account")
    customer_orders: Mapped[list["CustomerOrder"]] = relationship(back_populates="platform_account")
    customer_outreach_runs: Mapped[list["CustomerOutreachRun"]] = relationship(
        back_populates="platform_account"
    )


class Conversation(Base, TimestampMixin):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    platform_account_id: Mapped[str | None] = mapped_column(
        ForeignKey("platform_accounts.id"),
        index=True,
        nullable=True,
    )
    platform_code: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    external_conversation_id: Mapped[str | None] = mapped_column(String(128), index=True, nullable=True)
    customer_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    title: Mapped[str | None] = mapped_column(String(256), nullable=True)
    latest_message_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    latest_message_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    unread_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_message_sequence: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="active", nullable=False)
    awaiting_reply: Mapped[bool] = mapped_column(Boolean, default=False, index=True, nullable=False)
    human_required: Mapped[bool] = mapped_column(Boolean, default=False, index=True, nullable=False)
    human_required_reason: Mapped[str | None] = mapped_column(String(64), nullable=True)
    human_required_word: Mapped[str | None] = mapped_column(String(128), nullable=True)
    human_required_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    user: Mapped["User"] = relationship(back_populates="conversations")
    platform_account: Mapped["PlatformAccount | None"] = relationship(back_populates="conversations")
    messages: Mapped[list["Message"]] = relationship(back_populates="conversation", cascade="all, delete-orphan")
    tasks: Mapped[list["RpaTask"]] = relationship(back_populates="conversation")
    workflows: Mapped[list["ConversationWorkflow"]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan"
    )
    email_send_tasks: Mapped[list["EmailSendTask"]] = relationship(back_populates="conversation")
    automation_reply_runs: Mapped[list["AutomationReplyRun"]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan"
    )
    customer_orders: Mapped[list["CustomerOrder"]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan"
    )
    customer_outreach_runs: Mapped[list["CustomerOutreachRun"]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan"
    )


class MessageObservation(Base, TimestampMixin):
    __tablename__ = "message_observations"
    __table_args__ = (
        UniqueConstraint("observation_id", name="uq_message_observations_observation_id"),
        Index(
            "ix_message_observations_conversation_collected",
            "conversation_id",
            "collected_at",
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    observation_id: Mapped[str] = mapped_column(String(128), nullable=False)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    node_id: Mapped[str | None] = mapped_column(ForeignKey("rpa_nodes.id"), index=True, nullable=True)
    platform_account_id: Mapped[str] = mapped_column(
        ForeignKey("platform_accounts.id"), index=True, nullable=False
    )
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversations.id"), index=True, nullable=False
    )
    platform_code: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    conversation_external_id: Mapped[str] = mapped_column(String(128), index=True, nullable=False)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    unread: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    message_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    batch_count: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    received_batch_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    alignment_status: Mapped[str] = mapped_column(
        String(32), default="pending", index=True, nullable=False
    )
    alignment_method: Mapped[str | None] = mapped_column(String(32), nullable=True)
    overlap_size: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    projected_append_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    appended_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    raw_payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    diagnostics_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)


class Message(Base, TimestampMixin):
    __tablename__ = "messages"
    __table_args__ = (
        Index(
            "ix_messages_conversation_platform_message",
            "conversation_id",
            "platform_message_id",
        ),
        UniqueConstraint(
            "conversation_id",
            "conversation_sequence",
            name="uq_messages_conversation_sequence",
        ),
        UniqueConstraint(
            "first_observation_id",
            "first_dom_sequence",
            name="uq_messages_first_observation_sequence",
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"), index=True, nullable=False)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    platform_code: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    platform_message_id: Mapped[str | None] = mapped_column(String(128), index=True, nullable=True)
    sender_role: Mapped[str] = mapped_column(String(32), nullable=False)
    sender_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    message_status: Mapped[str] = mapped_column(String(32), default="sent", nullable=False)
    source: Mapped[str] = mapped_column(String(32), default="platform", nullable=False)
    raw_payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    conversation_sequence: Mapped[int | None] = mapped_column(Integer, nullable=True)
    collected_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=True
    )
    first_observation_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    first_dom_sequence: Mapped[int | None] = mapped_column(Integer, nullable=True)
    collection_kind: Mapped[str] = mapped_column(String(32), default="legacy", nullable=False)
    automation_eligible: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    platform_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    snapshot_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    snapshot_sequence: Mapped[int | None] = mapped_column(Integer, nullable=True)
    time_group_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    has_explicit_time: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    time_label: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    conversation: Mapped["Conversation"] = relationship(back_populates="messages")


class CustomerOrder(Base, TimestampMixin):
    __tablename__ = "customer_orders"
    __table_args__ = (
        UniqueConstraint(
            "platform_account_id", "platform_order_id", name="uq_customer_order_platform_order"
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    platform_account_id: Mapped[str] = mapped_column(
        ForeignKey("platform_accounts.id", ondelete="CASCADE"), index=True, nullable=False
    )
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    customer_key: Mapped[str] = mapped_column(String(160), index=True, nullable=False)
    platform_order_id: Mapped[str] = mapped_column(String(128), index=True, nullable=False)
    status: Mapped[str] = mapped_column(String(32), index=True, default="unknown", nullable=False)
    raw_status: Mapped[str] = mapped_column(String(128), default="", nullable=False)
    products_json: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    order_amount: Mapped[float | None] = mapped_column(Float, nullable=True)
    discount_amount: Mapped[float | None] = mapped_column(Float, nullable=True)
    paid_amount: Mapped[float | None] = mapped_column(Float, nullable=True)
    ordered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    signed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    after_sale_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    first_observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    last_observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    raw_payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    user: Mapped["User"] = relationship(back_populates="customer_orders")
    platform_account: Mapped["PlatformAccount"] = relationship(back_populates="customer_orders")
    conversation: Mapped["Conversation"] = relationship(back_populates="customer_orders")


class CustomerOutreachRun(Base, TimestampMixin):
    __tablename__ = "customer_outreach_runs"
    __table_args__ = (
        UniqueConstraint(
            "platform_account_id", "customer_key", "strategy_type",
            name="uq_customer_outreach_customer_strategy",
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    robot_id: Mapped[str] = mapped_column(
        ForeignKey("robots.id", ondelete="CASCADE"), index=True, nullable=False
    )
    platform_account_id: Mapped[str] = mapped_column(
        ForeignKey("platform_accounts.id", ondelete="CASCADE"), index=True, nullable=False
    )
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    customer_key: Mapped[str] = mapped_column(String(160), index=True, nullable=False)
    strategy_type: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    order_id: Mapped[str | None] = mapped_column(
        ForeignKey("customer_orders.id", ondelete="SET NULL"), index=True, nullable=True
    )
    source_message_id: Mapped[str | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL"), index=True, nullable=True
    )
    status: Mapped[str] = mapped_column(String(32), index=True, default="candidate", nullable=False)
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True, nullable=False)
    decision_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    message_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    message_id: Mapped[str | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL"), nullable=True
    )
    send_task_id: Mapped[str | None] = mapped_column(
        ForeignKey("rpa_tasks.id", ondelete="SET NULL"), nullable=True
    )
    idempotency_key: Mapped[str] = mapped_column(String(160), unique=True, index=True, nullable=False)
    cancel_reason: Mapped[str | None] = mapped_column(String(64), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped["User"] = relationship(back_populates="customer_outreach_runs")
    robot: Mapped["Robot"] = relationship(back_populates="customer_outreach_runs")
    platform_account: Mapped["PlatformAccount"] = relationship(back_populates="customer_outreach_runs")
    conversation: Mapped["Conversation"] = relationship(back_populates="customer_outreach_runs")
    order: Mapped["CustomerOrder | None"] = relationship()


class ConversationWorkflow(Base, TimestampMixin):
    __tablename__ = "conversation_workflows"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    robot_id: Mapped[str] = mapped_column(ForeignKey("robots.id"), index=True, nullable=False)
    workflow_type: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    status: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    intent: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    template_id: Mapped[str | None] = mapped_column(
        ForeignKey("email_templates.id", ondelete="SET NULL"), index=True, nullable=True
    )
    collected_slots_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    missing_slots_json: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    source_message_id: Mapped[str | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL"), index=True, nullable=True
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped["User"] = relationship(back_populates="conversation_workflows")
    conversation: Mapped["Conversation"] = relationship(back_populates="workflows")
    template: Mapped["EmailTemplate | None"] = relationship(back_populates="workflows")
    email_send_tasks: Mapped[list["EmailSendTask"]] = relationship(back_populates="workflow")


class EmailSendTask(Base, TimestampMixin):
    __tablename__ = "email_send_tasks"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    conversation_id: Mapped[str | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="SET NULL"), index=True, nullable=True
    )
    workflow_id: Mapped[str | None] = mapped_column(
        ForeignKey("conversation_workflows.id", ondelete="SET NULL"), index=True, nullable=True
    )
    template_id: Mapped[str] = mapped_column(
        ForeignKey("email_templates.id", ondelete="RESTRICT"), index=True, nullable=False
    )
    source_message_id: Mapped[str | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL"), index=True, nullable=True
    )
    idempotency_key: Mapped[str] = mapped_column(String(128), unique=True, index=True, nullable=False)
    recipient_email_encrypted: Mapped[str] = mapped_column(Text, nullable=False)
    recipient_email_masked: Mapped[str] = mapped_column(String(320), nullable=False)
    status: Mapped[str] = mapped_column(String(32), index=True, default="pending", nullable=False)
    provider_message_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped["User"] = relationship(back_populates="email_send_tasks")
    conversation: Mapped["Conversation | None"] = relationship(back_populates="email_send_tasks")
    workflow: Mapped["ConversationWorkflow | None"] = relationship(back_populates="email_send_tasks")
    template: Mapped["EmailTemplate"] = relationship(back_populates="send_tasks")


class RpaNode(Base, TimestampMixin):
    __tablename__ = "rpa_nodes"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    node_key: Mapped[str] = mapped_column(String(128), unique=True, index=True, nullable=False)
    hostname: Mapped[str] = mapped_column(String(128), nullable=False)
    machine_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    supported_platforms: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    app_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="online", nullable=False)
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    node_token_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    user: Mapped["User"] = relationship(back_populates="rpa_nodes")
    events: Mapped[list["RpaEvent"]] = relationship(back_populates="node")
    tasks: Mapped[list["RpaTask"]] = relationship(back_populates="node")


class RpaEvent(Base, TimestampMixin):
    __tablename__ = "rpa_events"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    node_id: Mapped[str | None] = mapped_column(ForeignKey("rpa_nodes.id"), index=True, nullable=True)
    platform_account_id: Mapped[str | None] = mapped_column(
        ForeignKey("platform_accounts.id"), index=True, nullable=True
    )
    event_id: Mapped[str] = mapped_column(String(128), unique=True, index=True, nullable=False)
    dedup_key: Mapped[str | None] = mapped_column(String(160), unique=True, index=True, nullable=True)
    event_type: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    platform_code: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    platform_message_id: Mapped[str | None] = mapped_column(String(128), index=True, nullable=True)
    conversation_external_id: Mapped[str | None] = mapped_column(String(128), index=True, nullable=True)
    payload_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="received", nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    user: Mapped["User"] = relationship(back_populates="rpa_events")
    node: Mapped["RpaNode | None"] = relationship(back_populates="events")
    platform_account: Mapped["PlatformAccount | None"] = relationship(back_populates="events")


class RpaTask(Base, TimestampMixin):
    __tablename__ = "rpa_tasks"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    node_id: Mapped[str | None] = mapped_column(ForeignKey("rpa_nodes.id"), index=True, nullable=True)
    platform_account_id: Mapped[str | None] = mapped_column(
        ForeignKey("platform_accounts.id"), index=True, nullable=True
    )
    conversation_id: Mapped[str | None] = mapped_column(ForeignKey("conversations.id"), index=True, nullable=True)
    message_id: Mapped[str | None] = mapped_column(ForeignKey("messages.id"), index=True, nullable=True)
    task_type: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(
        String(160), unique=True, index=True, nullable=True
    )
    platform_code: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    payload_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="queued", nullable=False)
    priority: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    acked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    result_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    user: Mapped["User"] = relationship(back_populates="rpa_tasks")
    node: Mapped["RpaNode | None"] = relationship(back_populates="tasks")
    conversation: Mapped["Conversation | None"] = relationship(back_populates="tasks")
    platform_account: Mapped["PlatformAccount | None"] = relationship(back_populates="tasks")


class AutomationReplyRun(Base, TimestampMixin):
    __tablename__ = "automation_reply_runs"
    __table_args__ = (
        UniqueConstraint(
            "robot_id", "source_message_id", name="uq_automation_reply_run_robot_source"
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    source_message_id: Mapped[str] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), index=True, nullable=False
    )
    source_event_id: Mapped[str | None] = mapped_column(
        ForeignKey("rpa_events.id", ondelete="SET NULL"), index=True, nullable=True
    )
    trigger_sequence: Mapped[int | None] = mapped_column(Integer, nullable=True)
    robot_id: Mapped[str] = mapped_column(
        ForeignKey("robots.id", ondelete="CASCADE"), index=True, nullable=False
    )
    status: Mapped[str] = mapped_column(String(32), index=True, default="pending", nullable=False)
    decision: Mapped[str | None] = mapped_column(String(32), nullable=True)
    intent: Mapped[str | None] = mapped_column(String(64), nullable=True)
    qa_entry_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    qa_category_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    qa_category_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    qa_match_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    document_retrieval_used: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    retrieval_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    human_required_marked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    human_required_reason: Mapped[str | None] = mapped_column(String(64), nullable=True)
    human_required_marked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reply_generation_duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    trace_id: Mapped[str | None] = mapped_column(String(128), index=True, nullable=True)
    reply_message_id: Mapped[str | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL"), nullable=True
    )
    send_task_id: Mapped[str | None] = mapped_column(
        ForeignKey("rpa_tasks.id", ondelete="SET NULL"), nullable=True
    )
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped["User"] = relationship(back_populates="automation_reply_runs")
    conversation: Mapped["Conversation"] = relationship(back_populates="automation_reply_runs")
    robot: Mapped["Robot"] = relationship(back_populates="automation_reply_runs")


class AiModelCall(Base, TimestampMixin):
    __tablename__ = "ai_model_calls"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=generate_id)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    automation_reply_run_id: Mapped[str] = mapped_column(
        ForeignKey("automation_reply_runs.id", ondelete="CASCADE"), index=True, nullable=False
    )
    robot_id: Mapped[str] = mapped_column(
        ForeignKey("robots.id", ondelete="CASCADE"), index=True, nullable=False
    )
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    trace_id: Mapped[str | None] = mapped_column(String(128), index=True, nullable=True)
    stage: Mapped[str] = mapped_column(String(32), nullable=False)
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    model: Mapped[str] = mapped_column(String(128), index=True, nullable=False)
    status: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

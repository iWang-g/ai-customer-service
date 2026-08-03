from __future__ import annotations

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine


def apply_compatibility_migrations(engine: Engine) -> None:
    """Upgrade databases created before Alembic was wired into startup."""
    if engine.dialect.name != "sqlite":
        return

    additions = {
        "platform_accounts": {
            "local_account_id": "VARCHAR(64)",
            "external_account_id": "VARCHAR(128)",
            "login_status": "VARCHAR(32) NOT NULL DEFAULT 'unknown'",
            "last_seen_at": "DATETIME",
            "last_rpa_node_id": "VARCHAR(32)",
        },
        "rpa_events": {"platform_account_id": "VARCHAR(32)"},
        "rpa_tasks": {
            "platform_account_id": "VARCHAR(32)",
            "idempotency_key": "VARCHAR(160)",
        },
        "messages": {
            "platform_sent_at": "DATETIME",
            "observed_at": "DATETIME",
            "snapshot_id": "VARCHAR(128)",
            "snapshot_sequence": "INTEGER",
            "time_group_index": "INTEGER",
            "has_explicit_time": "BOOLEAN",
            "time_label": "VARCHAR(64)",
        },
        "automation_reply_runs": {
            "intent": "VARCHAR(64)",
            "qa_entry_id": "VARCHAR(128)",
            "qa_category_id": "VARCHAR(128)",
            "qa_category_name": "VARCHAR(128)",
            "qa_match_type": "VARCHAR(32)",
            "document_retrieval_used": "BOOLEAN NOT NULL DEFAULT 0",
            "retrieval_count": "INTEGER NOT NULL DEFAULT 0",
        },
    }
    inspector = inspect(engine)
    with engine.begin() as connection:
        for table_name, columns in additions.items():
            if not inspector.has_table(table_name):
                continue
            existing = {column["name"] for column in inspector.get_columns(table_name)}
            for column_name, definition in columns.items():
                if column_name not in existing:
                    connection.execute(
                        text(f'ALTER TABLE "{table_name}" ADD COLUMN "{column_name}" {definition}')
                    )

        connection.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_accounts_user_platform_local "
                "ON platform_accounts (user_id, platform_code, local_account_id)"
            )
        )
        connection.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_accounts_user_platform_external "
                "ON platform_accounts (user_id, platform_code, external_account_id)"
            )
        )
        connection.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_rpa_events_platform_account_id "
                "ON rpa_events (platform_account_id)"
            )
        )
        connection.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_rpa_tasks_platform_account_id "
                "ON rpa_tasks (platform_account_id)"
            )
        )
        connection.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ix_rpa_tasks_idempotency_key "
                "ON rpa_tasks (idempotency_key)"
            )
        )
        connection.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_messages_collection_order "
                "ON messages (conversation_id, platform_sent_at, observed_at, snapshot_sequence)"
            )
        )
        connection.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_conversation_platform_message "
                "ON messages (conversation_id, platform_message_id)"
            )
        )
        connection.execute(text(
            """CREATE TABLE IF NOT EXISTS robot_qa_knowledge_bases (
                id VARCHAR(32) PRIMARY KEY,
                robot_id VARCHAR(32) NOT NULL REFERENCES robots(id) ON DELETE CASCADE,
                knowledge_base_id VARCHAR(128) NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_robot_qa_kb UNIQUE (robot_id, knowledge_base_id)
            )"""
        ))
        connection.execute(text(
            """CREATE TABLE IF NOT EXISTS robot_product_knowledge_bases (
                id VARCHAR(32) PRIMARY KEY,
                robot_id VARCHAR(32) NOT NULL REFERENCES robots(id) ON DELETE CASCADE,
                knowledge_base_id VARCHAR(128) NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_robot_product_kb UNIQUE (robot_id, knowledge_base_id)
            )"""
        ))
        connection.execute(text(
            """CREATE TABLE IF NOT EXISTS robot_tone_knowledge_bases (
                id VARCHAR(32) PRIMARY KEY,
                robot_id VARCHAR(32) NOT NULL UNIQUE REFERENCES robots(id) ON DELETE CASCADE,
                knowledge_base_id VARCHAR(128) NOT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )"""
        ))
        connection.execute(text(
            """CREATE TABLE IF NOT EXISTS robot_platform_scopes (
                id VARCHAR(32) PRIMARY KEY,
                robot_id VARCHAR(32) NOT NULL REFERENCES robots(id) ON DELETE CASCADE,
                platform_code VARCHAR(64) NOT NULL,
                platform_account_id VARCHAR(32) REFERENCES platform_accounts(id) ON DELETE CASCADE,
                all_accounts BOOLEAN NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_robot_platform_scope UNIQUE
                    (robot_id, platform_code, platform_account_id, all_accounts)
            )"""
        ))
        connection.execute(text(
            """CREATE TABLE IF NOT EXISTS email_provider_configs (
                id VARCHAR(32) PRIMARY KEY,
                user_id VARCHAR(32) NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                enabled BOOLEAN NOT NULL DEFAULT 0,
                provider VARCHAR(32) NOT NULL DEFAULT 'qq',
                sender_email VARCHAR(320) NOT NULL DEFAULT '',
                smtp_host VARCHAR(255) NOT NULL DEFAULT 'smtp.qq.com',
                smtp_port INTEGER NOT NULL DEFAULT 465,
                security VARCHAR(32) NOT NULL DEFAULT 'ssl',
                auth_secret_encrypted TEXT NOT NULL DEFAULT '',
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )"""
        ))
        connection.execute(text(
            """CREATE TABLE IF NOT EXISTS user_settings (
                id VARCHAR(32) PRIMARY KEY,
                user_id VARCHAR(32) NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                auto_reply_enabled BOOLEAN NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )"""
        ))
        connection.execute(text(
            """CREATE TABLE IF NOT EXISTS email_templates (
                id VARCHAR(32) PRIMARY KEY,
                user_id VARCHAR(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                template_key VARCHAR(80) NOT NULL,
                name VARCHAR(128) NOT NULL,
                scene VARCHAR(64) NOT NULL DEFAULT 'store_view_link',
                aliases JSON NOT NULL DEFAULT '[]',
                subject VARCHAR(256) NOT NULL,
                body TEXT NOT NULL,
                enabled BOOLEAN NOT NULL DEFAULT 1,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_email_template_user_key UNIQUE (user_id, template_key)
            )"""
        ))
        connection.execute(text(
            """CREATE TABLE IF NOT EXISTS conversation_workflows (
                id VARCHAR(32) PRIMARY KEY,
                user_id VARCHAR(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                conversation_id VARCHAR(32) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                robot_id VARCHAR(32) NOT NULL REFERENCES robots(id),
                workflow_type VARCHAR(64) NOT NULL,
                status VARCHAR(32) NOT NULL,
                intent VARCHAR(64) NOT NULL DEFAULT '',
                template_id VARCHAR(32) REFERENCES email_templates(id) ON DELETE SET NULL,
                collected_slots_json JSON NOT NULL DEFAULT '{}',
                missing_slots_json JSON NOT NULL DEFAULT '[]',
                source_message_id VARCHAR(32) REFERENCES messages(id) ON DELETE SET NULL,
                expires_at DATETIME,
                completed_at DATETIME,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )"""
        ))
        connection.execute(text(
            """CREATE TABLE IF NOT EXISTS email_send_tasks (
                id VARCHAR(32) PRIMARY KEY,
                user_id VARCHAR(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                conversation_id VARCHAR(32) REFERENCES conversations(id) ON DELETE SET NULL,
                workflow_id VARCHAR(32) REFERENCES conversation_workflows(id) ON DELETE SET NULL,
                template_id VARCHAR(32) NOT NULL REFERENCES email_templates(id) ON DELETE RESTRICT,
                source_message_id VARCHAR(32) REFERENCES messages(id) ON DELETE SET NULL,
                idempotency_key VARCHAR(128) NOT NULL UNIQUE,
                recipient_email_encrypted TEXT NOT NULL,
                recipient_email_masked VARCHAR(320) NOT NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'pending',
                provider_message_id VARCHAR(128),
                error_code VARCHAR(64),
                error_message TEXT,
                sent_at DATETIME,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )"""
        ))
        connection.execute(text(
            """CREATE TABLE IF NOT EXISTS automation_reply_runs (
                id VARCHAR(32) PRIMARY KEY,
                user_id VARCHAR(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                conversation_id VARCHAR(32) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                source_message_id VARCHAR(32) NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
                source_event_id VARCHAR(32) REFERENCES rpa_events(id) ON DELETE SET NULL,
                robot_id VARCHAR(32) NOT NULL REFERENCES robots(id) ON DELETE CASCADE,
                status VARCHAR(32) NOT NULL DEFAULT 'pending',
                decision VARCHAR(32),
                intent VARCHAR(64),
                qa_entry_id VARCHAR(128),
                qa_category_id VARCHAR(128),
                qa_category_name VARCHAR(128),
                qa_match_type VARCHAR(32),
                document_retrieval_used BOOLEAN NOT NULL DEFAULT 0,
                retrieval_count INTEGER NOT NULL DEFAULT 0,
                trace_id VARCHAR(128),
                reply_message_id VARCHAR(32) REFERENCES messages(id) ON DELETE SET NULL,
                send_task_id VARCHAR(32) REFERENCES rpa_tasks(id) ON DELETE SET NULL,
                error_message TEXT,
                completed_at DATETIME,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_automation_reply_run_robot_source
                    UNIQUE (robot_id, source_message_id)
            )"""
        ))
        for table, index, column in (
            ("robot_qa_knowledge_bases", "ix_robot_qa_kb_robot_id", "robot_id"),
            ("robot_product_knowledge_bases", "ix_robot_product_kb_robot_id", "robot_id"),
            ("robot_tone_knowledge_bases", "ix_robot_tone_kb_robot_id", "robot_id"),
            ("robot_platform_scopes", "ix_robot_platform_scopes_robot_id", "robot_id"),
            ("user_settings", "ix_user_settings_user_id", "user_id"),
            ("email_provider_configs", "ix_email_provider_configs_user_id", "user_id"),
            ("email_templates", "ix_email_templates_user_id", "user_id"),
            ("email_templates", "ix_email_templates_template_key", "template_key"),
            ("conversation_workflows", "ix_conversation_workflows_user_id", "user_id"),
            ("conversation_workflows", "ix_conversation_workflows_conversation_id", "conversation_id"),
            ("conversation_workflows", "ix_conversation_workflows_status", "status"),
            ("email_send_tasks", "ix_email_send_tasks_user_id", "user_id"),
            ("email_send_tasks", "ix_email_send_tasks_conversation_id", "conversation_id"),
            ("email_send_tasks", "ix_email_send_tasks_workflow_id", "workflow_id"),
            ("email_send_tasks", "ix_email_send_tasks_idempotency_key", "idempotency_key"),
            ("automation_reply_runs", "ix_automation_reply_runs_user_id", "user_id"),
            ("automation_reply_runs", "ix_automation_reply_runs_conversation_id", "conversation_id"),
            ("automation_reply_runs", "ix_automation_reply_runs_source_message_id", "source_message_id"),
            ("automation_reply_runs", "ix_automation_reply_runs_source_event_id", "source_event_id"),
            ("automation_reply_runs", "ix_automation_reply_runs_robot_id", "robot_id"),
            ("automation_reply_runs", "ix_automation_reply_runs_status", "status"),
            ("automation_reply_runs", "ix_automation_reply_runs_trace_id", "trace_id"),
        ):
            connection.execute(text(f"CREATE INDEX IF NOT EXISTS {index} ON {table} ({column})"))

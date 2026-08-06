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
            "conversation_sequence": "INTEGER",
            "collected_at": "DATETIME",
            "first_observation_id": "VARCHAR(128)",
            "first_dom_sequence": "INTEGER",
            "collection_kind": "VARCHAR(32) NOT NULL DEFAULT 'legacy'",
            "automation_eligible": "BOOLEAN NOT NULL DEFAULT 1",
            "platform_sent_at": "DATETIME",
            "observed_at": "DATETIME",
            "snapshot_id": "VARCHAR(128)",
            "snapshot_sequence": "INTEGER",
            "time_group_index": "INTEGER",
            "has_explicit_time": "BOOLEAN",
            "time_label": "VARCHAR(64)",
        },
        "conversations": {
            "last_message_sequence": "INTEGER NOT NULL DEFAULT 0",
            "awaiting_reply": "BOOLEAN NOT NULL DEFAULT 0",
            "human_required": "BOOLEAN NOT NULL DEFAULT 0",
            "human_required_reason": "VARCHAR(64)",
            "human_required_word": "VARCHAR(128)",
            "human_required_at": "DATETIME",
        },
        "automation_reply_runs": {
            "intent": "VARCHAR(64)",
            "qa_entry_id": "VARCHAR(128)",
            "qa_category_id": "VARCHAR(128)",
            "qa_category_name": "VARCHAR(128)",
            "qa_match_type": "VARCHAR(32)",
            "document_retrieval_used": "BOOLEAN NOT NULL DEFAULT 0",
            "retrieval_count": "INTEGER NOT NULL DEFAULT 0",
            "human_required_marked": "BOOLEAN NOT NULL DEFAULT 0",
            "human_required_reason": "VARCHAR(64)",
            "human_required_marked_at": "DATETIME",
            "reply_generation_duration_ms": "INTEGER",
        },
        "email_provider_configs": {
            "trigger_scenarios": "TEXT NOT NULL DEFAULT ''",
            "ask_email_text": "TEXT NOT NULL DEFAULT ''",
            "success_text": "TEXT NOT NULL DEFAULT ''",
            "missing_template_text": "TEXT NOT NULL DEFAULT ''",
        },
        "email_templates": {
            "platform_account_id": "VARCHAR(32)",
        },
    }
    inspector = inspect(engine)
    with engine.begin() as connection:
        added_columns: set[tuple[str, str]] = set()
        for table_name, columns in additions.items():
            if not inspector.has_table(table_name):
                continue
            existing = {column["name"] for column in inspector.get_columns(table_name)}
            for column_name, definition in columns.items():
                if column_name not in existing:
                    connection.execute(
                        text(f'ALTER TABLE "{table_name}" ADD COLUMN "{column_name}" {definition}')
                    )
                    added_columns.add((table_name, column_name))

        if ("conversations", "awaiting_reply") in added_columns:
            connection.execute(text(
                """UPDATE conversations
                SET awaiting_reply = CASE WHEN (
                    SELECT sender_role FROM messages
                    WHERE messages.conversation_id = conversations.id
                    ORDER BY COALESCE(platform_sent_at, observed_at, sent_at) DESC,
                             created_at DESC, id DESC
                    LIMIT 1
                ) = 'customer' THEN 1 ELSE 0 END"""
            ))

        # Freeze the legacy display order as the permanent per-conversation queue order.
        connection.execute(text(
            """WITH conversation_tails AS (
                SELECT conversation_id, COALESCE(MAX(conversation_sequence), 0) AS tail
                FROM messages
                GROUP BY conversation_id
            ),
            ranked_messages AS (
                SELECT id, conversation_id,
                       ROW_NUMBER() OVER (
                           PARTITION BY conversation_id
                           ORDER BY COALESCE(observed_at, sent_at, created_at) ASC,
                                    CASE WHEN snapshot_sequence IS NULL THEN 1 ELSE 0 END ASC,
                                    snapshot_sequence ASC,
                                    created_at ASC,
                                    id ASC
                       ) AS sequence_number
                FROM messages
                WHERE conversation_sequence IS NULL
            )
            UPDATE messages
            SET conversation_sequence = COALESCE((
                    SELECT tail
                    FROM conversation_tails
                    WHERE conversation_tails.conversation_id = messages.conversation_id
                ), 0) + (
                    SELECT sequence_number
                    FROM ranked_messages
                    WHERE ranked_messages.id = messages.id
                )
            WHERE conversation_sequence IS NULL"""
        ))
        connection.execute(text(
            """UPDATE messages
            SET collected_at = COALESCE(observed_at, sent_at, created_at, CURRENT_TIMESTAMP)
            WHERE collected_at IS NULL"""
        ))
        connection.execute(text(
            """UPDATE conversations
            SET last_message_sequence = COALESCE((
                SELECT MAX(messages.conversation_sequence)
                FROM messages
                WHERE messages.conversation_id = conversations.id
            ), 0)
            WHERE last_message_sequence < COALESCE((
                SELECT MAX(messages.conversation_sequence)
                FROM messages
                WHERE messages.conversation_id = conversations.id
            ), 0)"""
        ))

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
                "CREATE INDEX IF NOT EXISTS ix_conversations_human_required "
                "ON conversations (human_required)"
            )
        )
        connection.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_conversations_awaiting_reply "
                "ON conversations (awaiting_reply)"
            )
        )
        connection.execute(text(
            "DROP INDEX IF EXISTS uq_messages_conversation_platform_message"
        ))
        connection.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_messages_conversation_platform_message "
            "ON messages (conversation_id, platform_message_id)"
        ))
        connection.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_conversation_sequence "
            "ON messages (conversation_id, conversation_sequence)"
        ))
        connection.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_first_observation_sequence "
            "ON messages (first_observation_id, first_dom_sequence)"
        ))
        connection.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_email_template_user_platform_account "
                "ON email_templates (user_id, platform_account_id) "
                "WHERE platform_account_id IS NOT NULL"
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
                trigger_scenarios TEXT NOT NULL DEFAULT '',
                ask_email_text TEXT NOT NULL DEFAULT '',
                success_text TEXT NOT NULL DEFAULT '',
                missing_template_text TEXT NOT NULL DEFAULT '',
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
                platform_account_id VARCHAR(32) REFERENCES platform_accounts(id) ON DELETE SET NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_email_template_user_key UNIQUE (user_id, template_key),
                CONSTRAINT uq_email_template_user_platform_account UNIQUE (user_id, platform_account_id)
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
                human_required_marked BOOLEAN NOT NULL DEFAULT 0,
                human_required_reason VARCHAR(64),
                human_required_marked_at DATETIME,
                reply_generation_duration_ms INTEGER,
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
        connection.execute(text(
            """CREATE TABLE IF NOT EXISTS ai_model_calls (
                id VARCHAR(32) PRIMARY KEY,
                user_id VARCHAR(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                automation_reply_run_id VARCHAR(32) NOT NULL
                    REFERENCES automation_reply_runs(id) ON DELETE CASCADE,
                robot_id VARCHAR(32) NOT NULL REFERENCES robots(id) ON DELETE CASCADE,
                conversation_id VARCHAR(32) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                trace_id VARCHAR(128),
                stage VARCHAR(32) NOT NULL,
                provider VARCHAR(32) NOT NULL,
                model VARCHAR(128) NOT NULL,
                status VARCHAR(32) NOT NULL,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                error_message TEXT,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )"""
        ))
        connection.execute(text(
            """CREATE TABLE IF NOT EXISTS customer_orders (
                id VARCHAR(32) PRIMARY KEY,
                user_id VARCHAR(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                platform_account_id VARCHAR(32) NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
                conversation_id VARCHAR(32) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                customer_key VARCHAR(160) NOT NULL,
                platform_order_id VARCHAR(128) NOT NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'unknown',
                raw_status VARCHAR(128) NOT NULL DEFAULT '',
                products_json JSON NOT NULL DEFAULT '[]',
                order_amount FLOAT,
                discount_amount FLOAT,
                paid_amount FLOAT,
                ordered_at DATETIME,
                paid_at DATETIME,
                signed_at DATETIME,
                after_sale_json JSON NOT NULL DEFAULT '{}',
                first_observed_at DATETIME NOT NULL,
                last_observed_at DATETIME NOT NULL,
                raw_payload JSON NOT NULL DEFAULT '{}',
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_customer_order_platform_order
                    UNIQUE (platform_account_id, platform_order_id)
            )"""
        ))
        connection.execute(text(
            """CREATE TABLE IF NOT EXISTS customer_outreach_runs (
                id VARCHAR(32) PRIMARY KEY,
                user_id VARCHAR(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                robot_id VARCHAR(32) NOT NULL REFERENCES robots(id) ON DELETE CASCADE,
                platform_account_id VARCHAR(32) NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
                conversation_id VARCHAR(32) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                customer_key VARCHAR(160) NOT NULL,
                strategy_type VARCHAR(64) NOT NULL,
                order_id VARCHAR(32) REFERENCES customer_orders(id) ON DELETE SET NULL,
                source_message_id VARCHAR(32) REFERENCES messages(id) ON DELETE SET NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'candidate',
                due_at DATETIME NOT NULL,
                decision_json JSON NOT NULL DEFAULT '{}',
                message_text TEXT NOT NULL DEFAULT '',
                message_id VARCHAR(32) REFERENCES messages(id) ON DELETE SET NULL,
                send_task_id VARCHAR(32) REFERENCES rpa_tasks(id) ON DELETE SET NULL,
                idempotency_key VARCHAR(160) NOT NULL UNIQUE,
                cancel_reason VARCHAR(64),
                completed_at DATETIME,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_customer_outreach_customer_strategy
                    UNIQUE (platform_account_id, customer_key, strategy_type)
            )"""
        ))
        connection.execute(text(
            """CREATE TABLE IF NOT EXISTS message_observations (
                id VARCHAR(32) PRIMARY KEY,
                observation_id VARCHAR(128) NOT NULL UNIQUE,
                user_id VARCHAR(32) NOT NULL REFERENCES users(id),
                node_id VARCHAR(32) REFERENCES rpa_nodes(id),
                platform_account_id VARCHAR(32) NOT NULL REFERENCES platform_accounts(id),
                conversation_id VARCHAR(32) NOT NULL REFERENCES conversations(id),
                platform_code VARCHAR(32) NOT NULL,
                conversation_external_id VARCHAR(128) NOT NULL,
                collected_at DATETIME NOT NULL,
                unread BOOLEAN NOT NULL DEFAULT 0,
                payload_hash VARCHAR(64) NOT NULL,
                message_count INTEGER NOT NULL DEFAULT 0,
                batch_count INTEGER NOT NULL DEFAULT 1,
                received_batch_count INTEGER NOT NULL DEFAULT 0,
                alignment_status VARCHAR(32) NOT NULL DEFAULT 'pending',
                alignment_method VARCHAR(32),
                overlap_size INTEGER NOT NULL DEFAULT 0,
                projected_append_count INTEGER NOT NULL DEFAULT 0,
                appended_count INTEGER NOT NULL DEFAULT 0,
                raw_payload JSON NOT NULL DEFAULT '{}',
                diagnostics_json JSON NOT NULL DEFAULT '{}',
                processed_at DATETIME,
                error_message TEXT,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
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
            ("email_templates", "ix_email_templates_platform_account_id", "platform_account_id"),
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
            ("ai_model_calls", "ix_ai_model_calls_user_id", "user_id"),
            ("ai_model_calls", "ix_ai_model_calls_reply_run_id", "automation_reply_run_id"),
            ("ai_model_calls", "ix_ai_model_calls_robot_id", "robot_id"),
            ("ai_model_calls", "ix_ai_model_calls_conversation_id", "conversation_id"),
            ("ai_model_calls", "ix_ai_model_calls_trace_id", "trace_id"),
            ("ai_model_calls", "ix_ai_model_calls_model", "model"),
            ("ai_model_calls", "ix_ai_model_calls_status", "status"),
            ("customer_orders", "ix_customer_orders_user_id", "user_id"),
            ("customer_orders", "ix_customer_orders_platform_account_id", "platform_account_id"),
            ("customer_orders", "ix_customer_orders_conversation_id", "conversation_id"),
            ("customer_orders", "ix_customer_orders_customer_key", "customer_key"),
            ("customer_orders", "ix_customer_orders_platform_order_id", "platform_order_id"),
            ("customer_orders", "ix_customer_orders_status", "status"),
            ("customer_outreach_runs", "ix_customer_outreach_user_id", "user_id"),
            ("customer_outreach_runs", "ix_customer_outreach_robot_id", "robot_id"),
            ("customer_outreach_runs", "ix_customer_outreach_platform_account_id", "platform_account_id"),
            ("customer_outreach_runs", "ix_customer_outreach_conversation_id", "conversation_id"),
            ("customer_outreach_runs", "ix_customer_outreach_customer_key", "customer_key"),
            ("customer_outreach_runs", "ix_customer_outreach_strategy_type", "strategy_type"),
            ("customer_outreach_runs", "ix_customer_outreach_order_id", "order_id"),
            ("customer_outreach_runs", "ix_customer_outreach_source_message_id", "source_message_id"),
            ("customer_outreach_runs", "ix_customer_outreach_status", "status"),
            ("customer_outreach_runs", "ix_customer_outreach_due_at", "due_at"),
            ("customer_outreach_runs", "ix_customer_outreach_idempotency_key", "idempotency_key"),
            ("message_observations", "ix_message_observations_user_id", "user_id"),
            ("message_observations", "ix_message_observations_node_id", "node_id"),
            ("message_observations", "ix_message_observations_platform_account_id", "platform_account_id"),
            ("message_observations", "ix_message_observations_conversation_id", "conversation_id"),
            ("message_observations", "ix_message_observations_platform_code", "platform_code"),
            ("message_observations", "ix_message_observations_external_id", "conversation_external_id"),
            ("message_observations", "ix_message_observations_alignment_status", "alignment_status"),
        ):
            connection.execute(text(f"CREATE INDEX IF NOT EXISTS {index} ON {table} ({column})"))
        connection.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_message_observations_conversation_collected "
            "ON message_observations (conversation_id, collected_at)"
        ))

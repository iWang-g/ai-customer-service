from __future__ import annotations

import threading
import unittest
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import create_engine, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.migrations import apply_compatibility_migrations
from app.models import Base, Conversation, Message, User
from app.services.message_queue_service import append_message


class MessageQueueServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(
            username="message-queue",
            display_name="Message Queue",
            password_hash="not-used",
        )
        self.db.add(self.user)
        self.db.flush()
        self.conversation = Conversation(
            user_id=self.user.id,
            platform_code="pinduoduo",
            external_conversation_id="queue-customer",
        )
        self.db.add(self.conversation)
        self.db.flush()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_direct_inserts_receive_sequence_and_collection_time(self) -> None:
        first = Message(
            conversation_id=self.conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="customer",
            content="first",
        )
        second = Message(
            conversation_id=self.conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="agent",
            content="second",
        )
        self.db.add_all([first, second])
        self.db.commit()

        self.assertEqual((first.conversation_sequence, second.conversation_sequence), (1, 2))
        self.assertIsNotNone(first.collected_at)
        self.assertEqual(self.conversation.last_message_sequence, 2)

    def test_platform_message_id_is_unique_within_conversation(self) -> None:
        append_message(
            self.db,
            Message(
                conversation_id=self.conversation.id,
                user_id=self.user.id,
                platform_code="pinduoduo",
                platform_message_id="stable-platform-id",
                sender_role="customer",
                content="same-id-first",
            ),
        )
        self.db.commit()

        append_message(
            self.db,
            Message(
                conversation_id=self.conversation.id,
                user_id=self.user.id,
                platform_code="pinduoduo",
                platform_message_id="stable-platform-id",
                sender_role="customer",
                content="same-id-second",
            ),
        )
        with self.assertRaises(IntegrityError):
            self.db.commit()
        self.db.rollback()


class MessageQueueMigrationTests(unittest.TestCase):
    def test_automation_trigger_sequence_column_is_added_idempotently(self) -> None:
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        with engine.begin() as connection:
            connection.execute(text(
                "ALTER TABLE automation_reply_runs DROP COLUMN trigger_sequence"
            ))

        apply_compatibility_migrations(engine)
        apply_compatibility_migrations(engine)

        with engine.connect() as connection:
            columns = {
                row.name
                for row in connection.execute(text(
                    "PRAGMA table_info(automation_reply_runs)"
                )).all()
            }
            indexes = {
                row.name
                for row in connection.execute(text(
                    "PRAGMA index_list(automation_reply_runs)"
                )).all()
            }
        self.assertIn("trigger_sequence", columns)
        self.assertIn("ix_automation_reply_runs_trigger_sequence", indexes)
        engine.dispose()

    def test_backfill_is_ordered_and_idempotent(self) -> None:
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = Session(engine)
        user = User(username="migration", display_name="Migration", password_hash="not-used")
        db.add(user)
        db.flush()
        conversation = Conversation(
            user_id=user.id,
            platform_code="pinduoduo",
            external_conversation_id="migration-customer",
        )
        db.add(conversation)
        db.flush()
        start = datetime(2026, 8, 6, tzinfo=timezone.utc)
        rows = [
            Message(
                conversation_id=conversation.id,
                user_id=user.id,
                platform_code="pinduoduo",
                sender_role="customer",
                content=content,
                observed_at=observed_at,
                sent_at=observed_at,
            )
            for content, observed_at in (
                ("later", start + timedelta(minutes=1)),
                ("earlier", start),
            )
        ]
        db.add_all(rows)
        db.commit()
        ids = {row.content: row.id for row in rows}
        conversation_id = conversation.id
        db.close()

        with engine.begin() as connection:
            connection.execute(text("UPDATE messages SET conversation_sequence = NULL, collected_at = NULL"))
            connection.execute(text("UPDATE conversations SET last_message_sequence = 0"))

        apply_compatibility_migrations(engine)
        apply_compatibility_migrations(engine)

        with engine.connect() as connection:
            migrated = connection.execute(text(
                "SELECT id, conversation_sequence, collected_at FROM messages "
                "ORDER BY conversation_sequence"
            )).all()
            tail = connection.scalar(text(
                "SELECT last_message_sequence FROM conversations WHERE id = :id"
            ), {"id": conversation_id})
        self.assertEqual([row.id for row in migrated], [ids["earlier"], ids["later"]])
        self.assertEqual([row.conversation_sequence for row in migrated], [1, 2])
        self.assertTrue(all(row.collected_at is not None for row in migrated))
        self.assertEqual(tail, 2)
        engine.dispose()

    def test_platform_message_unique_index_migration_deduplicates_old_rows(self) -> None:
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = Session(engine)
        user = User(username="unique-migration", display_name="Unique Migration", password_hash="not-used")
        db.add(user)
        db.flush()
        conversation = Conversation(
            user_id=user.id,
            platform_code="pinduoduo",
            external_conversation_id="unique-customer",
        )
        db.add(conversation)
        db.flush()
        user_id = user.id
        conversation_id = conversation.id
        db.close()

        with engine.begin() as connection:
            connection.execute(text("DROP INDEX IF EXISTS uq_messages_conversation_platform_message"))
            connection.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_messages_conversation_platform_message "
                "ON messages (conversation_id, platform_message_id)"
            ))
            connection.execute(
                text(
                    """INSERT INTO messages (
                        id, conversation_id, user_id, platform_code, platform_message_id,
                        sender_role, content, message_status, source, raw_payload,
                        sent_at, created_at, updated_at, collection_kind, automation_eligible
                    ) VALUES (
                        :id, :conversation_id, :user_id, 'pinduoduo', 'same-platform-id',
                        'customer', :content, 'sent', 'rpa', '{}',
                        :sent_at, :sent_at, :sent_at, :collection_kind, 1
                    )"""
                ),
                [
                    {
                        "id": "duplicate-message-bootstrap",
                        "conversation_id": conversation_id,
                        "user_id": user_id,
                        "content": "bootstrap copy",
                        "sent_at": "2026-08-20 11:42:00",
                        "collection_kind": "bootstrap",
                    },
                    {
                        "id": "duplicate-message-incremental",
                        "conversation_id": conversation_id,
                        "user_id": user_id,
                        "content": "incremental copy",
                        "sent_at": "2026-08-20 10:20:00",
                        "collection_kind": "incremental",
                    },
                ],
            )

        apply_compatibility_migrations(engine)
        apply_compatibility_migrations(engine)

        with engine.connect() as connection:
            rows = connection.execute(text(
                "SELECT id, content FROM messages WHERE platform_message_id = 'same-platform-id'"
            )).all()
            indexes = {
                row.name: row
                for row in connection.execute(text("PRAGMA index_list(messages)")).all()
            }
            duplicate_insert_failed = False
            try:
                connection.execute(
                    text(
                        """INSERT INTO messages (
                            id, conversation_id, user_id, platform_code, platform_message_id,
                            sender_role, content, message_status, source, raw_payload,
                            sent_at, created_at, updated_at, collection_kind, automation_eligible
                        ) VALUES (
                            'duplicate-message-new', :conversation_id, :user_id, 'pinduoduo',
                            'same-platform-id', 'customer', 'new copy', 'sent', 'rpa', '{}',
                            '2026-08-20 12:00:00', '2026-08-20 12:00:00',
                            '2026-08-20 12:00:00', 'incremental', 1
                        )"""
                    ),
                    {"conversation_id": conversation_id, "user_id": user_id},
                )
            except IntegrityError:
                duplicate_insert_failed = True

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].id, "duplicate-message-incremental")
        self.assertIn("uq_messages_conversation_platform_message", indexes)
        self.assertTrue(indexes["uq_messages_conversation_platform_message"].unique)
        self.assertTrue(duplicate_insert_failed)
        engine.dispose()

    def test_parallel_append_allocates_unique_sequences(self) -> None:
        database_name = f"queue-{uuid4().hex}"
        engine = create_engine(
            f"sqlite:///file:{database_name}?mode=memory&cache=shared&uri=true",
            connect_args={"check_same_thread": False, "timeout": 10, "uri": True},
        )
        keeper = engine.connect()
        try:
            Base.metadata.create_all(engine)
            with Session(engine) as db:
                user = User(username="parallel", display_name="Parallel", password_hash="not-used")
                db.add(user)
                db.flush()
                conversation = Conversation(
                    user_id=user.id,
                    platform_code="pinduoduo",
                    external_conversation_id="parallel-customer",
                )
                db.add(conversation)
                db.commit()
                user_id = user.id
                conversation_id = conversation.id

            barrier = threading.Barrier(3)
            errors: list[BaseException] = []

            def insert_message(content: str) -> None:
                try:
                    with Session(engine) as worker_db:
                        barrier.wait()
                        append_message(
                            worker_db,
                            Message(
                                conversation_id=conversation_id,
                                user_id=user_id,
                                platform_code="pinduoduo",
                                sender_role="customer",
                                content=content,
                            ),
                        )
                        worker_db.commit()
                except BaseException as exc:  # pragma: no cover - assertion reports details
                    errors.append(exc)

            workers = [
                threading.Thread(target=insert_message, args=(f"parallel-{index}",))
                for index in range(2)
            ]
            for worker in workers:
                worker.start()
            barrier.wait()
            for worker in workers:
                worker.join()

            self.assertEqual(errors, [])
            with Session(engine) as db:
                sequences = list(db.scalars(
                    select(Message.conversation_sequence)
                    .where(Message.conversation_id == conversation_id)
                    .order_by(Message.conversation_sequence)
                ).all())
                tail = db.get(Conversation, conversation_id).last_message_sequence
            self.assertEqual(sequences, [1, 2])
            self.assertEqual(tail, 2)
        finally:
            keeper.close()
            engine.dispose()


if __name__ == "__main__":
    unittest.main()

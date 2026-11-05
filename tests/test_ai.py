import io
import json
import tempfile
import unittest
import urllib.error
from email.message import Message
from pathlib import Path
from unittest import mock

import server


class AIHelpersTest(unittest.TestCase):
    def test_chat_completions_url(self):
        self.assertEqual(
            server._chat_completions_url("https://api.example.com/v1"),
            "https://api.example.com/v1/chat/completions",
        )
        self.assertEqual(
            server._chat_completions_url("https://api.example.com/v1/chat/completions"),
            "https://api.example.com/v1/chat/completions",
        )
        self.assertEqual(
            server._chat_completions_url("https://api.example.com"),
            "https://api.example.com/v1/chat/completions",
        )
        self.assertEqual(
            server._chat_completions_url("https://example.com/api/paas/v4"),
            "https://example.com/api/paas/v4/chat/completions",
        )

    def test_origin_and_content_type_checks(self):
        self.assertTrue(server._origin_matches_host("", "127.0.0.1:8765"))
        self.assertTrue(
            server._origin_matches_host("http://127.0.0.1:8765", "127.0.0.1:8765")
        )
        self.assertFalse(
            server._origin_matches_host("https://127.0.0.1:8765", "127.0.0.1:8765")
        )
        self.assertFalse(
            server._origin_matches_host("http://127.0.0.1:9999", "127.0.0.1:8765")
        )
        self.assertFalse(server._origin_matches_host("http://evil.example", "127.0.0.1:8765"))
        self.assertFalse(server._origin_matches_host("null", "127.0.0.1:8765"))
        self.assertTrue(server._is_json_content_type("application/json; charset=utf-8"))
        self.assertFalse(server._is_json_content_type("text/plain"))
        self.assertFalse(server._is_json_content_type(""))

    def test_custom_instruction_block_keeps_system_rules_authoritative(self):
        block = server._custom_instruction_block("回答尽量短。")
        self.assertIn("回答尽量短。", block)
        self.assertIn("不能覆盖", block)
        self.assertIn("<user_instructions>", block)
        self.assertEqual(server._custom_instruction_block(""), "")

    def test_custom_instructions_are_injected_into_analysis_prompt(self):
        response_text = json.dumps({"questions": [], "pageWarnings": []})
        with (
            mock.patch.object(
                server,
                "_resolve_ai_config",
                return_value={
                    "endpoint": "http://example.test/v1",
                    "model": "text-model",
                    "apiKey": "",
                    "customInstructions": "回答尽量短，先给结论。",
                },
            ),
            mock.patch.object(
                server,
                "call_openai_compatible",
                return_value={
                    "text": response_text,
                    "usage": {},
                    "model": "text-model",
                },
            ) as call_ai,
        ):
            result = server.analyze_text_with_ai(
                {
                    "ocrText": "测试题目",
                    "filename": "test.png",
                    "pageNumber": 1,
                    "pageCount": 1,
                }
            )

        self.assertTrue(result["ok"])
        messages = call_ai.call_args.args[1]
        system_prompt = messages[0]["content"]
        self.assertIn("回答尽量短，先给结论。", system_prompt)
        self.assertIn("<user_instructions>", system_prompt)
        self.assertIn("<ocr_text>", messages[1]["content"])

    def test_ai_prompts_require_honest_conflict_verification(self):
        prompt = server.AI_TEXT_SYSTEM_PROMPT
        self.assertIn("自主搜索", prompt)
        self.assertIn("不得编造来源", prompt)
        self.assertIn("warnings", prompt)
        self.assertIn("不要假装已经搜索", server.AI_INTERACTION_MODE_PROMPTS["tutor"])

    def test_ai_call_retries_transient_http_errors(self):
        retry_headers = Message()
        retry_headers["Retry-After"] = "0"
        errors = [
            urllib.error.HTTPError(
                "http://example.test/v1/chat/completions",
                429,
                "rate limited",
                retry_headers,
                io.BytesIO(b'{"error":{"message":"slow down"}}'),
            ),
            urllib.error.HTTPError(
                "http://example.test/v1/chat/completions",
                503,
                "unavailable",
                retry_headers,
                io.BytesIO(b'{"error":{"message":"temporary"}}'),
            ),
        ]

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps(
                    {
                        "choices": [{"message": {"content": "OK"}}],
                        "usage": {"total_tokens": 3},
                        "model": "text-model",
                    }
                ).encode("utf-8")

        with (
            mock.patch.object(
                server.urllib.request,
                "urlopen",
                side_effect=[*errors, FakeResponse()],
            ) as urlopen,
            mock.patch.object(server.time, "sleep") as sleeper,
            mock.patch.object(server, "log"),
        ):
            result = server.call_openai_compatible(
                {
                    "endpoint": "http://example.test/v1",
                    "model": "text-model",
                    "apiKey": "",
                },
                [{"role": "user", "content": "test"}],
                max_tokens=20,
            )
        self.assertEqual(result["text"], "OK")
        self.assertEqual(urlopen.call_count, 3)
        self.assertEqual(sleeper.call_count, 2)

    def test_extract_json_object(self):
        payload = {
            "questions": [{"type": "single", "stem": "题目", "options": [], "answer": ""}],
            "pageWarnings": [],
        }
        raw = f"下面是结果：\n```json\n{json.dumps(payload, ensure_ascii=False)}\n```"
        self.assertEqual(server.extract_json_object(raw), payload)
        self.assertEqual(server.extract_json_object(json.dumps(payload)), payload)
        self.assertEqual(server.extract_json_object("[]"), {"questions": []})

    def test_normalize_ai_questions_and_remap_answer(self):
        payload = {
            "questions": [
                {
                    "sourceNumber": 1,
                    "type": "单选题",
                    "stem": "哪一个是质数？",
                    "options": [
                        {"key": "B", "text": "6"},
                        {"key": "A", "text": "7"},
                    ],
                    "answer": "B",
                    "confidence": 1.4,
                    "warnings": "选项顺序不确定",
                },
                {
                    "type": "judge",
                    "stem": "判断：植物细胞都有叶绿体。",
                    "options": [],
                    "answer": "错误",
                    "confidence": 0.8,
                },
            ],
            "pageWarnings": ["页眉已忽略"],
        }
        questions, warnings = server.normalize_ai_questions(payload, page_number=2)
        self.assertEqual(warnings, ["页眉已忽略"])
        self.assertEqual(len(questions), 2)
        first = questions[0]
        self.assertEqual(first["type"], "single")
        self.assertEqual(first["sourceNumber"], "1")
        self.assertEqual(first["page"], 2)
        self.assertEqual(first["confidence"], 1.0)
        # 原 B 选项变成了新的 A，答案也必须跟着映射。
        self.assertEqual(first["options"], [{"key": "A", "text": "6"}, {"key": "B", "text": "7"}])
        self.assertEqual(first["answer"], "A")
        self.assertEqual(first["warnings"], ["选项顺序不确定"])
        self.assertEqual(questions[1]["type"], "judge")

    def test_short_answer_type_is_preserved_and_options_are_cleared(self):
        payload = {
            "questions": [
                {
                    "type": "short_answer",
                    "stem": "简述光合作用的过程。",
                    "options": [{"key": "A", "text": "不应保留"}],
                    "answer": "光反应阶段和暗反应阶段。",
                    "confidence": 0.9,
                },
                {
                    "stem": "简述牛顿第一定律。",
                    "options": [],
                    "answer": "物体在不受外力时保持静止或匀速直线运动。",
                },
            ]
        }
        questions, warnings = server.normalize_ai_questions(payload)
        self.assertEqual(warnings, [])
        self.assertEqual(questions[0]["type"], "short")
        self.assertEqual(questions[0]["options"], [])
        self.assertEqual(questions[0]["answer"], "光反应阶段和暗反应阶段。")
        # 未给 type 时，明确出现“简述”的无选项题也按简答题处理。
        self.assertEqual(questions[1]["type"], "short")

    def test_normalize_rejects_missing_questions(self):
        with self.assertRaises(server.AIServiceError):
            server.normalize_ai_questions({"notQuestions": []})


class AIConfigTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_path = server.AI_CONFIG_PATH
        server.AI_CONFIG_PATH = Path(self.temp_dir.name) / "ai-config.json"

    def tearDown(self):
        server.AI_CONFIG_PATH = self.original_path
        self.temp_dir.cleanup()

    def test_config_masks_key_and_preserves_blank_key(self):
        saved = server.save_ai_config(
            {
                "endpoint": "https://api.example.com/v1",
                "model": "text-model",
                "apiKey": "sk-secret-123456",
            }
        )
        self.assertTrue(saved["configured"])
        self.assertNotIn("apiKey", saved)
        self.assertNotIn("sk-secret-123456", json.dumps(saved))

        updated = server.save_ai_config(
            {
                "endpoint": "https://api.example.com/v1",
                "model": "text-model-2",
                "apiKey": "",
            }
        )
        self.assertEqual(updated["model"], "text-model-2")
        self.assertTrue(server.get_ai_config()["apiKey"])

        cleared = server.save_ai_config(
            {
                "endpoint": "https://api.example.com/v1",
                "model": "text-model-2",
                "clearKey": True,
            }
        )
        self.assertFalse(cleared["hasApiKey"])

    def test_custom_instructions_round_trip_and_preserve_on_update(self):
        rules = "回答保持简洁。\n遇到答案冲突时说明依据。"
        saved = server.save_ai_config(
            {
                "endpoint": "https://api.example.com/v1",
                "model": "text-model",
                "apiKey": "sk-secret-123456",
                "customInstructions": rules,
            }
        )
        self.assertEqual(saved["customInstructions"], rules)
        self.assertEqual(server.get_ai_config()["customInstructions"], rules)
        self.assertNotIn("sk-secret-123456", json.dumps(saved))

        updated = server.save_ai_config(
            {
                "endpoint": "https://api.example.com/v1",
                "model": "text-model-2",
                "apiKey": "",
            }
        )
        self.assertEqual(updated["customInstructions"], rules)

        cleared = server.save_ai_config(
            {
                "endpoint": "https://api.example.com/v1",
                "model": "text-model-2",
                "customInstructions": "",
            }
        )
        self.assertEqual(cleared["customInstructions"], "")

    def test_custom_instructions_length_limit(self):
        with self.assertRaises(server.RequestProblem):
            server.save_ai_config(
                {
                    "endpoint": "https://api.example.com/v1",
                    "model": "text-model",
                    "customInstructions": "规" * (server.AI_INSTRUCTIONS_LIMIT + 1),
                }
            )

    def test_clear_all_config(self):
        server.save_ai_config(
            {"endpoint": "https://api.example.com/v1", "model": "text-model", "apiKey": "x"}
        )
        cleared = server.save_ai_config({"endpoint": "", "model": ""})
        self.assertFalse(cleared["configured"])
        self.assertFalse(server.AI_CONFIG_PATH.exists())

    def test_rejects_invalid_endpoint(self):
        with self.assertRaises(server.RequestProblem):
            server.save_ai_config(
                {"endpoint": "api.example.com/v1", "model": "text-model", "apiKey": "x"}
            )

class AIInteractionActionsTest(unittest.TestCase):
    def test_only_mode_actions_are_allowed(self):
        allowed = server._available_interaction_actions(
            "tutor",
            ["tutor_hint", "import_apply_all", "not_real", "tutor_hint"],
        )
        self.assertEqual([item["action"] for item in allowed], ["tutor_hint"])
        self.assertEqual(allowed[0]["kind"], "chat")

    def test_empty_client_action_list_means_no_actions(self):
        self.assertEqual(server._available_interaction_actions("library", []), [])

    def test_missing_client_list_gets_mode_defaults(self):
        allowed = server._available_interaction_actions("assistant", None)
        self.assertTrue(allowed)
        self.assertTrue(all(item["mode"] == "assistant" for item in allowed))



if __name__ == "__main__":
    unittest.main()

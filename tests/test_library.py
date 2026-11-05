import tempfile
import unittest
from pathlib import Path

import library_store
from library_store import (
    LibraryError,
    load_library,
    safe_bank_filename,
    safe_folder_name,
    sync_library,
)


def subject(name="高等数学", subject_id="subject_math"):
    return {
        "id": subject_id,
        "name": name,
        "createdAt": "2026-01-01T10:00:00+08:00",
        "updatedAt": "2026-01-01T10:00:00+08:00",
    }


def bank(name="第一章 极限", subject_id="subject_math", bank_id="bank_limits"):
    return {
        "id": bank_id,
        "subjectId": subject_id,
        "name": name,
        "createdAt": "2026-01-01T10:01:00+08:00",
        "updatedAt": "2026-01-01T10:01:00+08:00",
    }


def question(**overrides):
    data = {
        "id": "q_001",
        "subjectId": "subject_math",
        "bankId": "bank_limits",
        "type": "single",
        "stem": "当 x→0 时，sin x / x 的极限是多少？",
        "options": [
            {"key": "A", "text": "0"},
            {"key": "B", "text": "1"},
            {"key": "C", "text": "无穷"},
            {"key": "D", "text": "不存在"},
        ],
        "answer": "B",
        "explanation": "这是重要极限。",
        "favorite": True,
        "createdAt": "2026-01-01T10:02:00+08:00",
        "updatedAt": "2026-01-01T10:02:00+08:00",
    }
    data.update(overrides)
    return data


def payload(**overrides):
    data = {
        "subjects": [subject()],
        "banks": [bank()],
        "questions": [question()],
    }
    data.update(overrides)
    return data


def external_bank_markdown(stem="外部题库"):
    return f"""# 外部科目 · {stem}

<!-- shuati:question:start -->
## 第 1 题 · 单选题

**题目**

外部导入的题目

**选项**

- A. 错误选项
- B. 正确选项

**答案**

B

**解析**

来自用户手动放置的 MD。
<!-- shuati:question:end -->
"""


class LibraryMarkdownTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name) / "题库保存"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_sync_creates_subject_folder_and_one_markdown_per_bank(self):
        result = sync_library(self.root, payload())
        self.assertEqual(result["subjectCount"], 1)
        self.assertEqual(result["bankCount"], 1)
        self.assertEqual(result["questionCount"], 1)

        subject_dir = self.root / "高等数学"
        markdown_path = subject_dir / "第一章 极限.md"
        self.assertTrue((subject_dir / library_store.SUBJECT_META_FILE).is_file())
        self.assertTrue(markdown_path.is_file())
        self.assertFalse((subject_dir / "第一章 极限").exists())

        text = markdown_path.read_text(encoding="utf-8")
        self.assertIn("# 高等数学 · 第一章 极限", text)
        self.assertIn("当 x→0 时，sin x / x 的极限是多少？", text)
        self.assertIn("- A. 0", text)
        self.assertIn("**答案**", text)
        self.assertIn("这是重要极限。", text)
        self.assertIn("shuati:question:start", text)

        loaded = load_library(self.root)
        self.assertTrue(loaded["initialized"])
        self.assertEqual([item["name"] for item in loaded["subjects"]], ["高等数学"])
        self.assertEqual([item["name"] for item in loaded["banks"]], ["第一章 极限"])
        self.assertEqual(len(loaded["questions"]), 1)
        loaded_question = loaded["questions"][0]
        self.assertEqual(loaded_question["id"], "q_001")
        self.assertEqual(loaded_question["type"], "single")
        self.assertEqual(loaded_question["answer"], "B")
        self.assertEqual(loaded_question["subjectId"], "subject_math")
        self.assertEqual(loaded_question["bankId"], "bank_limits")
        self.assertTrue(loaded_question["favorite"])
        self.assertEqual([option["key"] for option in loaded_question["options"]], list("ABCD"))

    def test_multiline_content_and_field_labels_round_trip(self):
        multiline = question(
            type="fill",
            stem="第一行题干\n**答案** 这几个字也是题干\n第三行",
            options=[],
            answer="第一行答案\n第二行答案",
            explanation="解析第一行\n\n<!-- shuati:question:start -->\n解析最后一行",
        )
        sync_library(self.root, payload(questions=[multiline]))
        loaded = load_library(self.root)["questions"][0]
        self.assertEqual(loaded["stem"], multiline["stem"])
        self.assertEqual(loaded["answer"], multiline["answer"])
        self.assertEqual(loaded["explanation"], multiline["explanation"])
        self.assertEqual(loaded["options"], [])

    def test_banks_keep_creation_order_instead_of_filename_order(self):
        subject_data = subject()
        banks_data = [
            bank("1 第一章", bank_id="bank_one"),
            bank("2 第二章", bank_id="bank_two"),
            bank("10 第十章", bank_id="bank_ten"),
        ]
        for index, item in enumerate(banks_data, start=1):
            item["createdAt"] = f"2026-01-01T10:0{index}:00+08:00"
            item["updatedAt"] = item["createdAt"]
        sync_library(
            self.root,
            {"subjects": [subject_data], "banks": banks_data, "questions": []},
        )
        loaded = load_library(self.root)
        self.assertEqual(
            [item["name"] for item in loaded["banks"]],
            ["1 第一章", "2 第二章", "10 第十章"],
        )

    def test_explicit_bank_order_overrides_creation_order_and_round_trips(self):
        subject_data = subject()
        one = bank("第一章", bank_id="bank_one")
        two = bank("第二章", bank_id="bank_two")
        three = bank("第三章", bank_id="bank_three")
        one["order"] = 2
        two["order"] = 0
        three["order"] = 1
        for index, item in enumerate([one, two, three], start=1):
            item["createdAt"] = f"2026-01-01T10:0{index}:00+08:00"
            item["updatedAt"] = item["createdAt"]
        sync_library(
            self.root,
            {"subjects": [subject_data], "banks": [one, two, three], "questions": []},
        )
        markdown = (self.root / "高等数学" / "第二章.md").read_text(encoding="utf-8")
        self.assertIn('"order":0', markdown)

        loaded = load_library(self.root)
        self.assertEqual(
            [item["name"] for item in loaded["banks"]],
            ["第二章", "第三章", "第一章"],
        )
        self.assertEqual([item["order"] for item in loaded["banks"]], [0, 1, 2])

        sync_library(self.root, loaded)
        self.assertEqual(
            [item["name"] for item in load_library(self.root)["banks"]],
            ["第二章", "第三章", "第一章"],
        )

    def test_short_answer_round_trips_through_markdown(self):
        short = question(
            id="q_short",
            type="short",
            stem="简述光合作用的过程。",
            options=[],
            answer="1. 光反应阶段\n2. 暗反应阶段",
        )
        sync_library(self.root, payload(questions=[short]))
        markdown = (self.root / "高等数学" / "第一章 极限.md").read_text(encoding="utf-8")
        self.assertIn("## 第 1 题 · 简答题", markdown)

        loaded = load_library(self.root)["questions"][0]
        self.assertEqual(loaded["type"], "short")
        self.assertEqual(loaded["options"], [])
        self.assertEqual(loaded["answer"], short["answer"])

    def test_ai_review_warning_round_trips_through_markdown(self):
        review = {
            "flagged": True,
            "confidence": 0.62,
            "warnings": ["选项可能有识别歧义", "AI 未完成联网核验"],
            "sourceFilename": "第 3 页截图.png",
            "pageNumber": 3,
        }
        sync_library(self.root, payload(questions=[question(aiReview=review)]))
        markdown = (self.root / "高等数学" / "第一章 极限.md").read_text(encoding="utf-8")
        self.assertIn('"aiReview"', markdown)
        loaded = load_library(self.root)["questions"][0]
        self.assertEqual(loaded["aiReview"], review)

        sync_library(self.root, load_library(self.root))
        self.assertEqual(load_library(self.root)["questions"][0]["aiReview"], review)

    def test_option_text_with_reserved_markdown_round_trips(self):
        special = question(
            options=[
                {"key": "A", "text": "**答案**"},
                {"key": "B", "text": "<!-- shuati:question:start -->\n普通选项"},
            ],
            answer="B",
        )
        sync_library(self.root, payload(questions=[special]))
        loaded = load_library(self.root)["questions"][0]
        self.assertEqual([option["text"] for option in loaded["options"]], [
            "**答案**",
            "<!-- shuati:question:start -->\n普通选项",
        ])

    def test_copied_bank_gets_unique_question_ids_and_is_not_dropped(self):
        sync_library(self.root, payload())
        subject_dir = self.root / "高等数学"
        source = subject_dir / "第一章 极限.md"
        copied = subject_dir / "副本.md"
        copied.write_bytes(source.read_bytes())

        loaded = load_library(self.root)
        self.assertEqual(len(loaded["banks"]), 2)
        self.assertEqual(len(loaded["questions"]), 2)
        ids = [item["id"] for item in loaded["questions"]]
        self.assertEqual(len(set(ids)), 2)
        self.assertEqual({item["stem"] for item in loaded["questions"]}, {
            "当 x→0 时，sin x / x 的极限是多少？"
        })

        sync_library(self.root, loaded)
        self.assertTrue((subject_dir / "第一章 极限.md").is_file())
        self.assertTrue(copied.is_file())
        self.assertEqual(len(load_library(self.root)["questions"]), 2)

    def test_non_utf8_markdown_raises_library_error(self):
        subject_dir = self.root / "高等数学"
        subject_dir.mkdir(parents=True)
        (subject_dir / "GBK题库.md").write_bytes("中文".encode("gbk"))

        with self.assertRaises(LibraryError):
            load_library(self.root)

    def test_rename_moves_subject_folder_and_bank_file(self):
        sync_library(self.root, payload())
        subject_dir = self.root / "高等数学"
        (subject_dir / "source-image.jpg").write_bytes(b"not-a-real-image")

        renamed_subject = subject("微积分")
        renamed_bank = bank("极限与连续")
        sync_library(self.root, payload(subjects=[renamed_subject], banks=[renamed_bank]))

        new_dir = self.root / "微积分"
        self.assertFalse(subject_dir.exists())
        self.assertTrue((new_dir / "source-image.jpg").is_file())
        self.assertTrue((new_dir / "极限与连续.md").is_file())
        self.assertFalse((new_dir / "第一章 极限.md").exists())
        loaded = load_library(self.root)
        self.assertEqual(loaded["subjects"][0]["name"], "微积分")
        self.assertEqual(loaded["banks"][0]["name"], "极限与连续")

    def test_delete_removes_managed_markdown_but_keeps_other_files(self):
        sync_library(self.root, payload())
        subject_dir = self.root / "高等数学"
        (subject_dir / "keep-me.png").write_bytes(b"image")
        root_file = self.root / "readme.txt"
        root_file.write_text("keep", encoding="utf-8")

        sync_library(self.root, payload(questions=[], banks=[]))
        self.assertFalse((subject_dir / "第一章 极限.md").exists())
        self.assertTrue((subject_dir / "keep-me.png").is_file())
        self.assertTrue((subject_dir / library_store.SUBJECT_META_FILE).is_file())

        sync_library(self.root, payload(subjects=[], banks=[], questions=[]))
        self.assertFalse((subject_dir / library_store.SUBJECT_META_FILE).exists())
        self.assertTrue((subject_dir / "keep-me.png").is_file())
        self.assertTrue(root_file.is_file())
        loaded = load_library(self.root)
        # 带有用户文件的文件夹仍会被视为一个空科目，不会被删除。
        self.assertEqual([item["name"] for item in loaded["subjects"]], ["高等数学"])
        self.assertEqual(loaded["banks"], [])
        self.assertEqual(loaded["questions"], [])

    def test_empty_subject_folder_and_external_markdown_are_discovered(self):
        subject_dir = self.root / "外部科目"
        subject_dir.mkdir(parents=True)
        loaded = load_library(self.root)
        self.assertTrue(loaded["initialized"])
        self.assertEqual([item["name"] for item in loaded["subjects"]], ["外部科目"])
        self.assertEqual(loaded["banks"], [])

        (subject_dir / "外部题库.md").write_text(external_bank_markdown(), encoding="utf-8")
        loaded = load_library(self.root)
        self.assertEqual([item["name"] for item in loaded["banks"]], ["外部题库"])
        self.assertEqual(loaded["questions"][0]["answer"], "B")

        # 应用启动后的同步会补齐科目索引和题库元数据。
        sync_library(self.root, loaded)
        self.assertTrue((subject_dir / library_store.SUBJECT_META_FILE).is_file())
        self.assertIn(
            "shuati:bank",
            (subject_dir / "外部题库.md").read_text(encoding="utf-8"),
        )

    def test_safe_folder_and_bank_names(self):
        unsafe_folder = "../../数学/必修:一*二?三"
        unsafe_bank = "第一章/函数:极限*"
        folder = safe_folder_name(unsafe_folder)
        filename = safe_bank_filename(unsafe_bank)
        self.assertNotIn("/", folder)
        self.assertNotIn("\\", folder)
        self.assertNotIn(":", folder)
        self.assertFalse(folder.startswith(".."))
        self.assertTrue(filename.endswith(".md"))
        self.assertNotIn("/", filename)
        self.assertNotIn(":", filename)

        sync_library(
            self.root,
            payload(
                subjects=[subject(unsafe_folder)],
                banks=[bank(unsafe_bank)],
            ),
        )
        self.assertEqual(len([path for path in self.root.iterdir() if path.is_dir()]), 1)
        self.assertEqual(len(load_library(self.root)["banks"]), 1)

    def test_unknown_existing_markdown_is_not_silently_overwritten(self):
        subject_dir = self.root / "高等数学"
        subject_dir.mkdir(parents=True)
        target = subject_dir / "第一章 极限.md"
        target.write_text("# 用户自己写的笔记\n", encoding="utf-8")

        with self.assertRaises(LibraryError):
            sync_library(self.root, payload())
        self.assertEqual(target.read_text(encoding="utf-8"), "# 用户自己写的笔记\n")

    def test_empty_library_and_missing_directory(self):
        loaded = load_library(self.root)
        self.assertFalse(loaded["initialized"])
        self.assertEqual(loaded["subjects"], [])
        self.assertEqual(loaded["banks"], [])
        self.assertEqual(loaded["questions"], [])


if __name__ == "__main__":
    unittest.main()

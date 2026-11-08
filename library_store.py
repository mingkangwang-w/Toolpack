#!/usr/bin/env python3
"""把科目和题库保存为「题库保存」目录中的 Markdown 文件。

目录结构：
    题库保存/
      科目名/
        子题库一.md
        子题库二.md
      另一个科目/
        子题库.md

每个 MD 文件代表一个子题库；科目由文件夹产生。少量机器元数据放在
HTML 注释和隐藏的科目索引文件中。题目与答案保持为可读的 Markdown。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

SUBJECT_META_FILE = ".shuati-subject.json"
BANK_SUFFIX = ".md"
FORMAT_VERSION = 1
MAX_NAME_LENGTH = 80
MAX_STEM_LENGTH = 100_000
MAX_TEXT_LENGTH = 200_000

TYPE_LABELS = {
    "single": "单选题",
    "multiple": "多选题",
    "judge": "判断题",
    "fill": "填空题",
    "short": "简答题",
}
VALID_TYPES = set(TYPE_LABELS)
VALID_OPTION_KEYS = "ABCDEFGH"
WINDOWS_RESERVED = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
FIELD_RE = re.compile(r"^\*\*(题目|选项|答案|解析)\*\*\s*$", re.MULTILINE)
QUESTION_RE = re.compile(
    r"(?m)^<!-- shuati:question:start -->\s*$"
    r"(.*?)"
    r"^<!-- shuati:question:end -->\s*$",
    re.DOTALL,
)
BANK_META_RE = re.compile(r"<!--\s*shuati:bank\s*(.*?)\s*-->", re.DOTALL)
QUESTION_META_RE = re.compile(r"<!--\s*shuati:question\s*(.*?)\s*-->", re.DOTALL)
INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
OPTION_LINE_RE = re.compile(r"^-\s*([A-H])\s*[.、:]\s*(.*)$")


class LibraryError(ValueError):
    """题库文件读写错误，可直接显示给用户。"""


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _clean_text(value: Any, limit: int = MAX_TEXT_LENGTH) -> str:
    if value is None:
        return ""
    text = str(value).replace("\r\n", "\n").replace("\r", "\n").strip()
    return text[:limit]


def _clean_name(value: Any) -> str:
    name = re.sub(r"\s+", " ", str(value or "")).strip()
    return name[:MAX_NAME_LENGTH]


def safe_folder_name(name: str) -> str:
    """过滤 Windows 不能用于文件夹的字符，同时保留可读名称。"""
    cleaned = INVALID_FILENAME_CHARS.sub(" ", _clean_name(name))
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    cleaned = cleaned[:MAX_NAME_LENGTH].strip(" .")
    if not cleaned:
        cleaned = "未命名"
    if cleaned.split(".", 1)[0].upper() in WINDOWS_RESERVED:
        cleaned = f"_{cleaned}"
    return cleaned


def safe_bank_filename(name: str) -> str:
    """把子题库名称转换为目录中的 .md 文件名。"""
    cleaned = _clean_name(name)
    if cleaned.lower().endswith(BANK_SUFFIX):
        cleaned = cleaned[: -len(BANK_SUFFIX)]
    stem = safe_folder_name(cleaned)
    return f"{stem}{BANK_SUFFIX}"


def _sha_id(prefix: str, value: str) -> str:
    digest = hashlib.sha1(value.casefold().encode("utf-8")).hexdigest()[:16]
    return f"{prefix}_{digest}"


def _derive_subject_id(root: Path, subject_dir: Path) -> str:
    try:
        relative = subject_dir.relative_to(root).as_posix()
    except ValueError:
        relative = subject_dir.name
    return _sha_id("subject", relative)


def _derive_bank_id(root: Path, bank_path: Path) -> str:
    try:
        relative = bank_path.relative_to(root).as_posix()
    except ValueError:
        relative = f"{bank_path.parent.name}/{bank_path.name}"
    return _sha_id("bank", relative)


def _iso_from_path(path: Path) -> str:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime).astimezone().isoformat(timespec="seconds")
    except OSError:
        return _now_iso()


def _iso_timestamp(value: str) -> float | None:
    """把 ISO 时间转为可排序时间戳；无法解析时返回 None。"""
    text = _clean_text(value, 80)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _normalize_bank_order(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        order = int(value)
    except (TypeError, ValueError):
        return None
    return order if order >= 0 else None


def _bank_entry_sort_key(entry: dict) -> tuple[int, int, float, str]:
    """优先使用用户拖拽后的顺序，否则按创建时间排序。"""
    created = _iso_timestamp(entry.get("createdAt", ""))
    if created is None:
        try:
            created = entry["path"].stat().st_mtime
        except OSError:
            created = 0.0
    order = entry.get("order")
    if order is not None:
        return (0, order, created, entry["path"].name.casefold())
    return (1, 0, created, entry["path"].name.casefold())


def _normalize_ai_review(value: Any) -> dict | None:
    if not isinstance(value, dict):
        return None

    raw_warnings = value.get("warnings")
    if isinstance(raw_warnings, str):
        raw_warnings = [raw_warnings]
    if not isinstance(raw_warnings, list):
        raw_warnings = []
    warnings = []
    for item in raw_warnings[:8]:
        warning = _clean_text(item, 300)
        if warning and warning not in warnings:
            warnings.append(warning)

    confidence = None
    try:
        confidence = float(value.get("confidence"))
        confidence = min(1.0, max(0.0, confidence))
    except (TypeError, ValueError):
        confidence = None

    page_number = None
    try:
        page_number = int(value.get("pageNumber"))
        if page_number < 1:
            page_number = None
    except (TypeError, ValueError):
        page_number = None

    low_confidence = confidence is not None and confidence < 0.7
    if not value.get("flagged") and not warnings and not low_confidence:
        return None
    return {
        "flagged": True,
        "confidence": round(confidence, 3) if confidence is not None else None,
        "warnings": warnings,
        "sourceFilename": _clean_text(value.get("sourceFilename"), 200),
        "pageNumber": page_number,
    }


def _normalize_meta(raw: dict, fallback_id: str = "") -> dict:
    meta = raw if isinstance(raw, dict) else {}
    return {
        "id": _clean_text(meta.get("id"), 200) or fallback_id,
        "createdAt": _clean_text(meta.get("createdAt"), 80) or _now_iso(),
        "updatedAt": _clean_text(meta.get("updatedAt"), 80) or _now_iso(),
    }


def _normalize_payload(payload: dict) -> tuple[list[dict], list[dict], list[dict]]:
    if not isinstance(payload, dict):
        raise LibraryError("题库数据格式不正确。")

    raw_subjects = payload.get("subjects")
    raw_banks = payload.get("banks")
    raw_questions = payload.get("questions")
    if not isinstance(raw_subjects, list) or not isinstance(raw_banks, list) or not isinstance(raw_questions, list):
        raise LibraryError("题库数据缺少科目、子题库或题目列表。")

    subjects: list[dict] = []
    subject_ids: set[str] = set()
    subject_names: set[str] = set()
    for item in raw_subjects:
        if not isinstance(item, dict):
            raise LibraryError("科目数据格式不正确。")
        subject_id = _clean_text(item.get("id"), 200)
        name = _clean_name(item.get("name"))
        if not subject_id or not name:
            raise LibraryError("科目缺少 ID 或名称。")
        if subject_id in subject_ids:
            raise LibraryError(f"科目 ID 重复：{subject_id}")
        key = name.casefold()
        if key in subject_names:
            raise LibraryError(f"科目名称重复：{name}")
        subject_ids.add(subject_id)
        subject_names.add(key)
        meta = _normalize_meta(item, subject_id)
        subjects.append(
            {
                "id": subject_id,
                "name": name,
                "createdAt": meta["createdAt"],
                "updatedAt": meta["updatedAt"],
            }
        )

    banks: list[dict] = []
    bank_ids: set[str] = set()
    bank_names: set[tuple[str, str]] = set()
    for item in raw_banks:
        if not isinstance(item, dict):
            raise LibraryError("子题库数据格式不正确。")
        bank_id = _clean_text(item.get("id"), 200)
        subject_id = _clean_text(item.get("subjectId"), 200)
        name = _clean_name(item.get("name"))
        if not bank_id or not subject_id or not name:
            raise LibraryError("子题库缺少 ID、科目或名称。")
        if subject_id not in subject_ids:
            raise LibraryError(f"子题库「{name}」所属科目不存在。")
        if bank_id in bank_ids:
            raise LibraryError(f"子题库 ID 重复：{bank_id}")
        key = (subject_id, name.casefold())
        if key in bank_names:
            raise LibraryError(f"同一科目下有重名子题库：{name}")
        bank_ids.add(bank_id)
        bank_names.add(key)
        meta = _normalize_meta(item, bank_id)
        banks.append(
            {
                "id": bank_id,
                "subjectId": subject_id,
                "name": name,
                "order": _normalize_bank_order(item.get("order")),
                "createdAt": meta["createdAt"],
                "updatedAt": meta["updatedAt"],
            }
        )

    bank_by_id = {bank["id"]: bank for bank in banks}
    questions: list[dict] = []
    question_ids: set[str] = set()
    for item in raw_questions:
        if not isinstance(item, dict):
            raise LibraryError("题目数据格式不正确。")
        question_id = _clean_text(item.get("id"), 200)
        bank_id = _clean_text(item.get("bankId"), 200)
        stem = _clean_text(item.get("stem"), MAX_STEM_LENGTH)
        if not question_id or not bank_id or not stem:
            raise LibraryError("有题目缺少 ID、所属子题库或题干。")
        if bank_id not in bank_by_id:
            raise LibraryError("有题目所属的子题库不存在，已停止写入以保护数据。")
        if question_id in question_ids:
            raise LibraryError(f"题目 ID 重复：{question_id}")
        question_ids.add(question_id)

        qtype = _clean_text(item.get("type"), 20).lower()
        if qtype not in VALID_TYPES:
            qtype = "fill"

        options: list[dict] = []
        raw_options = item.get("options") if isinstance(item.get("options"), list) else []
        for index, raw_option in enumerate(raw_options[: len(VALID_OPTION_KEYS)]):
            if not isinstance(raw_option, dict):
                continue
            text = _clean_text(raw_option.get("text"), MAX_TEXT_LENGTH)
            if not text:
                continue
            key = _clean_text(raw_option.get("key"), 1).upper()
            if key not in VALID_OPTION_KEYS:
                key = VALID_OPTION_KEYS[index]
            options.append({"key": key, "text": text})

        meta = _normalize_meta(item, question_id)
        questions.append(
            {
                "id": question_id,
                "subjectId": bank_by_id[bank_id]["subjectId"],
                "bankId": bank_id,
                "type": qtype,
                "stem": stem,
                "options": options,
                "answer": _clean_text(item.get("answer"), MAX_TEXT_LENGTH),
                "explanation": _clean_text(item.get("explanation"), MAX_TEXT_LENGTH),
                "favorite": bool(item.get("favorite")),
                "aiReview": _normalize_ai_review(item.get("aiReview")),
                "createdAt": meta["createdAt"],
                "updatedAt": meta["updatedAt"],
            }
        )

    return subjects, banks, questions


def _json_meta(kind: str, meta: dict) -> str:
    raw = json.dumps(meta, ensure_ascii=False, separators=(",", ":"))
    # 避免用户名称里的 HTML 注释片段提前结束元数据注释。
    safe = raw.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return f"<!-- shuati:{kind}\n{safe}\n-->"


def _escape_block(value: str) -> str:
    lines = []
    for line in _clean_text(value).split("\n"):
        if re.fullmatch(r"\*\*(题目|选项|答案|解析)\*\*\s*", line) or re.match(
            r"^<!--\s*shuati:", line
        ):
            line = f"\\{line}"
        lines.append(line)
    return "\n".join(lines).strip("\n")


def _unescape_block(value: str) -> str:
    lines = []
    for line in value.replace("\r\n", "\n").split("\n"):
        if re.match(r"^\\(?:\*\*(题目|选项|答案|解析)\*\*|<!--\s*shuati:)", line):
            line = line[1:]
        lines.append(line)
    return "\n".join(lines).strip("\n")


def _question_markdown(question: dict, index: int) -> str:
    qtype = question["type"] if question["type"] in TYPE_LABELS else "fill"
    meta = {
        "id": question["id"],
        "type": qtype,
        "favorite": bool(question.get("favorite")),
        "createdAt": question.get("createdAt", ""),
        "updatedAt": question.get("updatedAt", ""),
    }
    ai_review = _normalize_ai_review(question.get("aiReview"))
    if ai_review:
        meta["aiReview"] = ai_review

    option_lines: list[str] = []
    for option in question.get("options", []):
        lines = _escape_block(option.get("text", "")).split("\n")
        first = f"- {option['key']}. {lines[0] if lines else ''}"
        option_lines.append(first)
        option_lines.extend(f"  {line}" for line in lines[1:])
    options_block = "\n".join(option_lines) or "_（无选项）_"

    return f"""<!-- shuati:question:start -->
## 第 {index} 题 · {TYPE_LABELS[qtype]}

{_json_meta("question", meta)}

**题目**

{_escape_block(question.get("stem", ""))}

**选项**

{options_block}

**答案**

{_escape_block(question.get("answer", ""))}

**解析**

{_escape_block(question.get("explanation", ""))}
<!-- shuati:question:end -->"""


def _bank_markdown(subject: dict, bank: dict, questions: list[dict]) -> str:
    meta = {
        "format": FORMAT_VERSION,
        "managed": True,
        "id": bank["id"],
        "subjectId": subject["id"],
        "subjectName": subject["name"],
        "name": bank["name"],
        "createdAt": bank.get("createdAt", ""),
        "updatedAt": bank.get("updatedAt", ""),
    }
    if bank.get("order") is not None:
        meta["order"] = bank["order"]
    question_markdown = "\n\n".join(
        _question_markdown(question, index) for index, question in enumerate(questions, start=1)
    )
    body = question_markdown or "_这个子题库还没有题目。_"
    return f"""# {subject['name']} · {bank['name']}

> 本文件由「刷题助手」维护。题目和答案以 Markdown 保存，建议在应用内修改；应用保存时会自动重写此文件。

{_json_meta("bank", meta)}

{body}
"""


def _write_if_changed(path: Path, content: str) -> None:
    try:
        if path.is_file():
            try:
                if path.read_text(encoding="utf-8-sig") == content:
                    return
            except UnicodeError as exc:
                raise LibraryError(f"题库文件不是 UTF-8 编码：{path.name}") from exc
        temp = path.with_name(f".{path.name}.tmp")
        temp.write_text(content, encoding="utf-8", newline="\n")
        os.replace(temp, path)
    except OSError as exc:
        raise LibraryError(f"无法写入题库文件：{path.name}（{exc}）") from exc


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig")
    except UnicodeError as exc:
        raise LibraryError(f"题库文件不是 UTF-8 编码，请转码后重试：{path.name}") from exc
    except OSError as exc:
        raise LibraryError(f"无法读取题库文件：{path}（{exc}）") from exc


def _extract_meta(text: str, regex: re.Pattern[str]) -> dict | None:
    match = regex.search(text)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(1))
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _extract_field(block: str, label: str) -> str:
    matches = list(FIELD_RE.finditer(block))
    for index, match in enumerate(matches):
        if match.group(1) != label:
            continue
        end = matches[index + 1].start() if index + 1 < len(matches) else len(block)
        return _unescape_block(block[match.end() : end].strip("\n"))
    return ""


def _parse_options(block: str) -> list[dict]:
    options: list[dict] = []
    for line in block.split("\n"):
        match = OPTION_LINE_RE.match(line)
        if match:
            text = match.group(2).strip()
            if text:
                options.append({"key": match.group(1), "text": text})
            continue
        if options and line.startswith("  "):
            continuation = line[2:]
            options[-1]["text"] = f"{options[-1]['text']}\n{continuation}".strip()
    for option in options:
        option["text"] = _unescape_block(option["text"])
    return options


def _parse_question(block: str, index: int, bank_id: str) -> dict | None:
    meta = _extract_meta(block, QUESTION_META_RE) or {}
    stem = _extract_field(block, "题目").strip()
    if not stem:
        return None

    qtype = _clean_text(meta.get("type"), 20).lower()
    if qtype not in VALID_TYPES:
        heading_match = re.search(
            r"·\s*(单选题|多选题|判断题|填空题|简答题|解答题|问答题|论述题|名词解释)",
            block,
        )
        label_to_type = {label: value for value, label in TYPE_LABELS.items()}
        label_to_type.update(
            {"解答题": "short", "问答题": "short", "论述题": "short", "名词解释": "short"}
        )
        qtype = (
            label_to_type.get(heading_match.group(1), "fill") if heading_match else "fill"
        )

    question_id = _clean_text(meta.get("id"), 200)
    if not question_id:
        digest = hashlib.sha1(f"{bank_id}:{index}:{stem}".encode("utf-8")).hexdigest()[:16]
        question_id = f"q_{digest}"

    return {
        "id": question_id,
        "bankId": bank_id,
        "type": qtype,
        "stem": stem,
        "options": _parse_options(_extract_field(block, "选项")),
        "answer": _extract_field(block, "答案").strip(),
        "explanation": _extract_field(block, "解析").strip(),
        "favorite": bool(meta.get("favorite")),
        "aiReview": _normalize_ai_review(meta.get("aiReview")),
        "createdAt": _clean_text(meta.get("createdAt"), 80) or _now_iso(),
        "updatedAt": _clean_text(meta.get("updatedAt"), 80) or _now_iso(),
    }


def _subject_dirs(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    return sorted(
        (path for path in root.iterdir() if path.is_dir() and not path.name.startswith(".")),
        key=lambda path: path.name.casefold(),
    )


def _bank_files(subject_dir: Path) -> list[Path]:
    if not subject_dir.is_dir():
        return []
    return sorted(
        (
            path
            for path in subject_dir.iterdir()
            if path.is_file()
            and path.suffix.lower() == BANK_SUFFIX
            and not path.name.startswith(".")
        ),
        key=lambda path: path.name.casefold(),
    )


def _read_subject_marker(subject_dir: Path) -> dict | None:
    marker = subject_dir / SUBJECT_META_FILE
    if not marker.is_file():
        return None
    try:
        parsed = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _subject_marker_json(subject: dict) -> str:
    return json.dumps(
        {
            "format": FORMAT_VERSION,
            "managed": True,
            "id": subject["id"],
            "name": subject["name"],
            "createdAt": subject.get("createdAt", ""),
            "updatedAt": subject.get("updatedAt", ""),
        },
        ensure_ascii=False,
        indent=2,
    ) + "\n"


def _path_key(path: Path) -> str:
    return os.path.normcase(str(path.resolve()))


def _remove_file(path: Path) -> None:
    try:
        if path.is_file():
            path.unlink()
    except OSError as exc:
        raise LibraryError(f"无法删除旧题库文件：{path.name}（{exc}）") from exc


def _remove_empty_dir(path: Path) -> None:
    try:
        if path.is_dir() and not any(path.iterdir()):
            path.rmdir()
    except OSError:
        pass


def _scan_layout(root: Path) -> list[dict]:
    """扫描所有科目文件夹和直接位于其中的 .md 子题库。"""
    root = Path(root)
    subjects: list[dict] = []
    used_subject_ids: set[str] = set()
    used_bank_ids: set[str] = set()

    for subject_dir in _subject_dirs(root):
        marker = _read_subject_marker(subject_dir) or {}
        marker_id = _clean_text(marker.get("id"), 200)
        bank_entries: list[dict] = []
        subject_id_candidates: list[str] = []

        for bank_path in _bank_files(subject_dir):
            text = _read_text(bank_path)
            meta = _extract_meta(text, BANK_META_RE) or {}
            meta_id = _clean_text(meta.get("id"), 200)
            meta_subject_id = _clean_text(meta.get("subjectId"), 200)
            if meta_subject_id:
                subject_id_candidates.append(meta_subject_id)
            bank_entries.append(
                {
                    "path": bank_path,
                    "name": bank_path.stem,
                    "meta": meta or None,
                    "meta_id": meta_id,
                    "order": _normalize_bank_order(meta.get("order")),
                    "createdAt": _clean_text(meta.get("createdAt"), 80) or _iso_from_path(bank_path),
                    "updatedAt": _clean_text(meta.get("updatedAt"), 80) or _iso_from_path(bank_path),
                }
            )

        subject_id = marker_id
        if not subject_id and subject_id_candidates:
            subject_id = Counter(subject_id_candidates).most_common(1)[0][0]
        if not subject_id:
            subject_id = _derive_subject_id(root, subject_dir)
        if subject_id in used_subject_ids:
            subject_id = _derive_subject_id(root, subject_dir)
        used_subject_ids.add(subject_id)

        for entry in bank_entries:
            bank_id = entry["meta_id"]
            if not bank_id or bank_id in used_bank_ids:
                bank_id = _derive_bank_id(root, entry["path"])
            used_bank_ids.add(bank_id)
            entry["id"] = bank_id
            entry["subjectId"] = subject_id

        # 文件系统按文件名枚举，不能代表用户创建顺序；这里恢复创建顺序。
        bank_entries.sort(key=_bank_entry_sort_key)

        marker_created = _clean_text(marker.get("createdAt"), 80)
        marker_updated = _clean_text(marker.get("updatedAt"), 80)
        if bank_entries:
            created_at = marker_created or min(entry["createdAt"] for entry in bank_entries)
            updated_at = marker_updated or max(entry["updatedAt"] for entry in bank_entries)
        else:
            created_at = marker_created or _iso_from_path(subject_dir)
            updated_at = marker_updated or _iso_from_path(subject_dir)

        subjects.append(
            {
                "dir": subject_dir,
                "id": subject_id,
                "name": subject_dir.name,
                "marker": bool(marker),
                "createdAt": created_at,
                "updatedAt": updated_at,
                "banks": bank_entries,
            }
        )

    return subjects


def parse_bank_files(files: list[dict], default_subject: str = "导入题库") -> list[dict]:
    """解析从网页上传的 Markdown 子题库文件，不写入磁盘。"""
    if not isinstance(files, list) or not files:
        raise LibraryError("没有收到 Markdown 题库文件。")
    if len(files) > 500:
        raise LibraryError("一次最多导入 500 个 Markdown 文件。")

    results: list[dict] = []
    for item in files:
        if not isinstance(item, dict):
            continue
        raw_path = _clean_text(item.get("path") or item.get("name"), 800).replace("\\", "/")
        text = _clean_text(item.get("text"), 4_000_000)
        if not text.strip():
            continue

        parts = [part for part in raw_path.split("/") if part and part not in {".", ".."}]
        filename = parts[-1] if parts else "导入题库.md"
        meta = _extract_meta(text, BANK_META_RE) or {}
        bank_name = _clean_name(Path(filename).stem) or _clean_name(meta.get("name")) or "导入题库"

        subject_name = _clean_name(parts[-2]) if len(parts) >= 2 else ""
        if not subject_name:
            subject_name = _clean_name(meta.get("subjectName"))
        if not subject_name:
            subject_name = _clean_name(default_subject) or "导入题库"

        bank_key = hashlib.sha1(f"{subject_name}/{bank_name}".encode("utf-8")).hexdigest()[:16]
        questions: list[dict] = []
        for index, match in enumerate(QUESTION_RE.finditer(text), start=1):
            question = _parse_question(match.group(1), index, f"import_{bank_key}")
            if not question:
                continue
            question.pop("bankId", None)
            questions.append(question)

        if questions:
            results.append(
                {
                    "subjectName": subject_name,
                    "bankName": bank_name,
                    "questions": questions,
                }
            )

    if not results:
        raise LibraryError("没有从 Markdown 文件中解析出题目。请确认文件是刷题助手生成的题库格式。")
    return results


def load_library(root: Path) -> dict:
    """从「题库保存」目录读取科目和 Markdown 子题库。"""
    root = Path(root)
    scanned = _scan_layout(root)
    questions: list[dict] = []
    seen_question_ids: set[str] = set()

    for subject in scanned:
        for bank in subject["banks"]:
            text = _read_text(bank["path"])
            for index, match in enumerate(QUESTION_RE.finditer(text), start=1):
                question = _parse_question(match.group(1), index, bank["id"])
                if not question:
                    continue
                if question["id"] in seen_question_ids:
                    # 复制子题库文件时题目 ID 会重复；派生新 ID，避免静默丢失副本。
                    digest = hashlib.sha1(
                        (
                            f"{bank['id']}:{index}:{question['id']}:{question['stem']}"
                        ).encode("utf-8")
                    ).hexdigest()[:16]
                    candidate = f"q_{digest}"
                    suffix = 2
                    while candidate in seen_question_ids:
                        candidate = f"q_{digest}_{suffix}"
                        suffix += 1
                    question["id"] = candidate
                question["subjectId"] = subject["id"]
                seen_question_ids.add(question["id"])
                questions.append(question)

    return {
        "root": root.name,
        "initialized": bool(scanned),
        "subjects": [
            {
                "id": subject["id"],
                "name": subject["name"],
                "createdAt": subject["createdAt"],
                "updatedAt": subject["updatedAt"],
            }
            for subject in scanned
        ],
        "banks": [
            {
                "id": bank["id"],
                "subjectId": subject["id"],
                "name": bank["name"],
                "order": bank.get("order"),
                "createdAt": bank["createdAt"],
                "updatedAt": bank["updatedAt"],
            }
            for subject in scanned
            for bank in subject["banks"]
        ],
        "questions": questions,
    }


def sync_library(root: Path, payload: dict) -> dict:
    """把完整题库同步到「题库保存」中的科目文件夹和各 .md 文件。"""
    root = Path(root)
    subjects, banks, questions = _normalize_payload(payload)
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise LibraryError(f"无法创建题库保存目录：{root}（{exc}）") from exc

    existing_subjects = _scan_layout(root)
    existing_by_id = {item["id"]: item for item in existing_subjects}

    desired_subject_dirs: dict[str, Path] = {}
    used_subject_paths: dict[str, str] = {}
    for subject in subjects:
        folder = safe_folder_name(subject["name"])
        desired = root / folder
        key = _path_key(desired)
        if key in used_subject_paths:
            raise LibraryError(
                f"科目「{subject['name']}」和「{used_subject_paths[key]}」会生成同名文件夹，请改名。"
            )
        used_subject_paths[key] = subject["name"]
        if desired.exists() and not desired.is_dir():
            raise LibraryError(f"目标路径「{folder}」已存在且不是文件夹。")

        existing = existing_by_id.get(subject["id"])
        if existing and _path_key(existing["dir"]) != _path_key(desired):
            if desired.exists():
                raise LibraryError(f"无法把科目「{subject['name']}」移动到已存在的文件夹「{desired.name}」。")
            try:
                existing["dir"].rename(desired)
            except OSError as exc:
                raise LibraryError(f"无法移动科目文件夹：{exc}") from exc
        elif not existing and desired.exists():
            marker = _read_subject_marker(desired) or {}
            occupied_id = _clean_text(marker.get("id"), 200)
            if occupied_id and occupied_id != subject["id"]:
                raise LibraryError(f"文件夹「{desired.name}」已被其他科目占用。")

        try:
            desired.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise LibraryError(f"无法创建科目文件夹：{desired.name}（{exc}）") from exc
        desired_subject_dirs[subject["id"]] = desired
        _write_if_changed(desired / SUBJECT_META_FILE, _subject_marker_json(subject))

    # 科目文件夹重命名后，重新扫描当前 .md 文件，用于安全清理旧文件。
    current_subjects = _scan_layout(root)
    current_bank_files = [
        bank for subject in current_subjects for bank in subject["banks"]
    ]

    subject_by_id = {subject["id"]: subject for subject in subjects}
    questions_by_bank: dict[str, list[dict]] = {bank["id"]: [] for bank in banks}
    for question in questions:
        questions_by_bank[question["bankId"]].append(question)

    desired_bank_paths: dict[str, Path] = {}
    used_bank_paths: dict[str, str] = {}
    for bank in banks:
        subject = subject_by_id[bank["subjectId"]]
        subject_dir = desired_subject_dirs[subject["id"]]
        filename = safe_bank_filename(bank["name"])
        desired = subject_dir / filename
        key = _path_key(desired)
        if key in used_bank_paths:
            raise LibraryError(
                f"子题库「{bank['name']}」和「{used_bank_paths[key]}」会生成同名文件，请改名。"
            )
        used_bank_paths[key] = bank["name"]
        if desired.exists() and not desired.is_file():
            raise LibraryError(f"目标路径「{filename}」已存在且不是文件。")
        if desired.is_file():
            meta = _extract_meta(_read_text(desired), BANK_META_RE)
            if meta is None:
                # 允许接手用户直接放进来的、符合题目格式但没有助手元数据的文件。
                derived_id = _derive_bank_id(root, desired)
                if derived_id != bank["id"]:
                    raise LibraryError(f"文件「{filename}」已存在且不是当前题库管理的文件。")
        desired_bank_paths[bank["id"]] = desired

    desired_bank_ids = {bank["id"] for bank in banks}
    desired_paths = {_path_key(path) for path in desired_bank_paths.values()}

    # 先写完整内容，再清理旧文件；这样改名和互换文件名都不会丢题。
    for bank in banks:
        subject = subject_by_id[bank["subjectId"]]
        target = desired_bank_paths[bank["id"]]
        _write_if_changed(
            target,
            _bank_markdown(subject, bank, questions_by_bank[bank["id"]]),
        )

    # 清理旧路径下的受管文件；未带助手元数据的用户文件保持不动。
    for entry in current_bank_files:
        path_key = _path_key(entry["path"])
        if path_key in desired_paths:
            continue
        if entry["meta"] is None:
            continue
        desired_for_id = desired_bank_paths.get(entry["id"])
        if entry["id"] in desired_bank_ids and desired_for_id is not None:
            # 子题库被改名；旧路径的受管文件需要删除。
            if _path_key(desired_for_id) != path_key:
                _remove_file(entry["path"])
            continue
        if entry["id"] not in desired_bank_ids:
            _remove_file(entry["path"])

    # 删除不再存在的受管科目：只移除隐藏标记和空文件夹，保留其它文件。
    desired_subject_ids = {subject["id"] for subject in subjects}
    for subject_dir in _subject_dirs(root):
        marker = _read_subject_marker(subject_dir)
        if not marker:
            continue
        marker_id = _clean_text(marker.get("id"), 200)
        if marker_id in desired_subject_ids:
            continue
        _remove_file(subject_dir / SUBJECT_META_FILE)
        _remove_empty_dir(subject_dir)

    return {
        "root": root.name,
        "subjectCount": len(subjects),
        "bankCount": len(banks),
        "questionCount": len(questions),
        "file": f"科目名/{safe_bank_filename('子题库')}",
        "updatedAt": _now_iso(),
    }

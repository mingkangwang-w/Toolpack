#!/usr/bin/env python3
"""AI 知识图谱的本地 JSON 存储。

知识图谱不写进 Markdown 题库正文，而是保存在「题库保存/.shuati-knowledge/」
下的独立 JSON 文件中，按子题库 ID 命名。扫描题库时只读取 .md 文件，
因此这些 JSON 不会被误认为子题库。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

KNOWLEDGE_DIR = ".shuati-knowledge"
KNOWLEDGE_KIND = "knowledge-map"
KNOWLEDGE_FORMAT = 1
MAX_KNOWLEDGE_BYTES = 2 * 1024 * 1024
MAX_NODES = 200
MAX_NODE_LABEL = 60
MAX_NODE_SUMMARY = 500
MAX_KEYWORDS = 8
MAX_KEYWORD_LENGTH = 30
MAX_RELATIONS = 24
MAX_QUESTION_REFS = 500
MAX_NODE_DEPTH = 4
MAX_ID_LENGTH = 120
SAFE_KEY_RE = re.compile(r"[^A-Za-z0-9_-]+")
WINDOWS_RESERVED = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


class KnowledgeError(ValueError):
    """知识图谱读写错误，可直接显示给用户。"""


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _clean_text(value: Any, limit: int) -> str:
    if value is None:
        return ""
    text = str(value).replace("\r\n", "\n").replace("\r", "\n").strip()
    return text[:limit]


def _clean_name(value: Any, limit: int = MAX_ID_LENGTH) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def knowledge_key(bank_id: str) -> str:
    """把子题库 ID 转成安全的文件名；非安全字符会附加短哈希避免撞名。"""
    key = _clean_name(bank_id, 200)
    if not key:
        raise KnowledgeError("缺少子题库 ID。")
    safe = SAFE_KEY_RE.sub("_", key).strip("_")[:100]
    if not safe:
        safe = "bank"
    if safe.split(".", 1)[0].upper() in WINDOWS_RESERVED:
        safe = f"_{safe}"
    if safe != key or len(key) > 100:
        safe = f"{safe}_{hashlib.sha1(key.encode('utf-8')).hexdigest()[:10]}"
    return safe


def knowledge_dir(root: Path) -> Path:
    return Path(root) / KNOWLEDGE_DIR


def knowledge_path(root: Path, bank_id: str) -> Path:
    return knowledge_dir(root) / f"{knowledge_key(bank_id)}.json"


def _clean_keywords(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in raw[: MAX_KEYWORDS * 2]:
        text = _clean_name(item, MAX_KEYWORD_LENGTH)
        if text and text not in seen:
            seen.add(text)
            result.append(text)
        if len(result) >= MAX_KEYWORDS:
            break
    return result


def _clean_relations(
    raw: Any,
    node_ids: set[str],
    own_id: str,
    label_to_id: dict[str, str] | None = None,
) -> list[dict]:
    if not isinstance(raw, list):
        return []
    result: list[dict] = []
    seen: set[tuple[str, str]] = set()
    labels = label_to_id or {}
    for item in raw[: MAX_RELATIONS * 2]:
        if not isinstance(item, dict):
            continue
        target = _clean_name(item.get("to") or item.get("target"), 120)
        if target not in node_ids:
            target = labels.get(target, "")
        label = _clean_name(item.get("label") or item.get("relation"), 40)
        if not target or target == own_id or target not in node_ids:
            continue
        key = (target, label)
        if key in seen:
            continue
        seen.add(key)
        result.append({"to": target, "label": label})
        if len(result) >= MAX_RELATIONS:
            break
    return result


def _clean_index_questions(raw: Any, valid_indexes: set[int]) -> list[int]:
    if isinstance(raw, str):
        raw = [part for part in re.split(r"[,，;；、\s]+", raw) if part]
    if not isinstance(raw, list):
        return []
    result: list[int] = []
    seen: set[int] = set()
    for item in raw[: MAX_QUESTION_REFS * 2]:
        if isinstance(item, dict):
            item = item.get("i") or item.get("index") or item.get("number")
        try:
            value = int(item)
        except (TypeError, ValueError):
            # 兼容“#1”“第1题”“题号1”这类写法；UUID 等长字符串不会被误当成题号。
            match = re.fullmatch(
                r"(?:题号|第)?\s*#?\s*(\d{1,4})\s*(?:题)?",
                str(item or "").strip(),
            )
            if not match:
                continue
            value = int(match.group(1))
        if value in valid_indexes and value not in seen:
            seen.add(value)
            result.append(value)
        if len(result) >= MAX_QUESTION_REFS:
            break
    return result


def _clean_question_ids(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in raw[: MAX_QUESTION_REFS * 2]:
        text = _clean_name(item, 200)
        if text and text not in seen:
            seen.add(text)
            result.append(text)
        if len(result) >= MAX_QUESTION_REFS:
            break
    return result


def _fix_graph(nodes: list[dict], max_depth: int = MAX_NODE_DEPTH) -> list[dict]:
    """修正缺失 parent、自引用和环，并限制最大深度。"""
    by_id = {node["id"]: node for node in nodes}
    for node in nodes:
        parent = node.get("parentId") or "root"
        if parent != "root" and (parent not in by_id or parent == node["id"]):
            parent = "root"
        node["parentId"] = parent

    # 断开环：沿 parent 链向上走，遇到已访问节点就把当前节点挂回根。
    for node in nodes:
        seen: set[str] = set()
        current = node
        while current["parentId"] != "root":
            parent = by_id.get(current["parentId"])
            if parent is None:
                current["parentId"] = "root"
                break
            if parent["id"] in seen or parent["id"] == node["id"]:
                node["parentId"] = "root"
                break
            seen.add(parent["id"])
            current = parent

    def depth(node: dict) -> int:
        value = 0
        current = node
        seen: set[str] = set()
        while current["parentId"] != "root" and value <= max_depth + 2:
            if current["id"] in seen:
                break
            seen.add(current["id"])
            parent = by_id.get(current["parentId"])
            if parent is None:
                break
            current = parent
            value += 1
        return value

    for node in nodes:
        if depth(node) > max_depth:
            node["parentId"] = "root"
    return nodes


def _prune_empty(nodes: list[dict], question_field: str) -> list[dict]:
    """只删除完全没有内容、也没有子节点的空叶子节点。

    有 summary 或 keywords 的知识点即使没有关联题目也保留，避免模型
    漏写题号时整张图直接生成失败；未关联的题目会在前端归入「未归类」。
    """
    current = list(nodes)
    while True:
        child_count: dict[str, int] = {}
        for node in current:
            parent = node["parentId"]
            child_count[parent] = child_count.get(parent, 0) + 1
        kept: list[dict] = []
        removed = False
        for node in current:
            if (
                not node.get(question_field)
                and child_count.get(node["id"], 0) == 0
                and not node.get("summary")
                and not node.get("keywords")
            ):
                removed = True
                continue
            kept.append(node)
        current = kept
        if not removed:
            return current


def _limit_nodes(nodes: list[dict], max_nodes: int) -> list[dict]:
    if len(nodes) <= max_nodes:
        return nodes
    by_parent: dict[str, list[dict]] = {}
    for node in nodes:
        by_parent.setdefault(node["parentId"], []).append(node)
    kept: list[dict] = []
    queue = list(by_parent.get("root", []))
    while queue and len(kept) < max_nodes:
        node = queue.pop(0)
        kept.append(node)
        queue.extend(by_parent.get(node["id"], []))
    return kept


def _extract_raw_nodes(payload: dict) -> list:
    """从 AI 返回的 JSON 中找出节点数组，兼容常见的外层字段。"""
    if not isinstance(payload, dict):
        return []
    for key in ("nodes", "knowledgePoints", "points", "children", "items"):
        value = payload.get(key)
        if isinstance(value, list) and value:
            return value
        if isinstance(value, dict):
            return [value]
    for key in ("tree", "root"):
        value = payload.get(key)
        if isinstance(value, dict):
            children = value.get("children") or value.get("subNodes") or value.get("nodes")
            if isinstance(children, list) and children:
                return children
            return [value]
        if isinstance(value, list) and value:
            return value
    questions = payload.get("questions")
    if (
        isinstance(questions, list)
        and questions
        and all(isinstance(item, dict) for item in questions)
    ):
        # 模型直接返回节点数组时，extract_json_object 会把它包成
        # {"questions": [...]}，这里按节点数组处理。
        return questions
    if isinstance(payload.get("label"), str) or isinstance(payload.get("name"), str):
        return [payload]
    return []


def _flatten_node_tree(raw_nodes: list) -> list[dict]:
    """把嵌套 children 树拍平成带 parentId 的节点列表，同时保留扁平输入。"""
    flat: list[dict] = []
    counter = 0
    seen_objects: set[int] = set()

    def visit(raw, parent_id: str, depth: int) -> None:
        nonlocal counter
        if not isinstance(raw, dict) or depth > 12:
            return
        object_id = id(raw)
        if object_id in seen_objects:
            return
        seen_objects.add(object_id)

        counter += 1
        explicit_id = _clean_name(raw.get("id"), 80)
        node_id = explicit_id or f"ai_{counter}"
        explicit_parent = _clean_name(raw.get("parentId") or raw.get("parent"), 80)
        if parent_id != "root":
            node_parent = parent_id
        else:
            node_parent = explicit_parent or "root"

        refs = raw.get("questions")
        if refs is None:
            refs = raw.get("questionIndexes")
        if refs is None:
            refs = raw.get("questionIds")

        flat.append(
            {
                "id": node_id,
                "parentId": node_parent,
                "label": raw.get("label")
                or raw.get("name")
                or raw.get("title")
                or raw.get("topic"),
                "summary": raw.get("summary") or raw.get("description"),
                "keywords": raw.get("keywords"),
                "questions": refs,
                "relations": raw.get("relations"),
            }
        )

        children: list = []
        for key in ("children", "subNodes", "subnodes", "nodes", "items"):
            value = raw.get(key)
            if isinstance(value, list):
                children.extend(value)
        for child in children:
            visit(child, node_id, depth + 1)

    for raw in raw_nodes:
        visit(raw, "root", 0)
    return flat


def _finalize_nodes(
    raw_nodes: Any,
    *,
    field_name: str,
    get_refs: Callable[[dict], list],
    max_nodes: int,
) -> list[dict]:
    if not isinstance(raw_nodes, list):
        return []
    nodes: list[dict] = []
    used_ids: set[str] = set()
    for index, raw in enumerate(raw_nodes[: max_nodes * 3]):
        if not isinstance(raw, dict):
            continue
        label = _clean_name(
            raw.get("label") or raw.get("name") or raw.get("title") or raw.get("topic"),
            MAX_NODE_LABEL,
        )
        if not label:
            continue
        raw_id = _clean_name(raw.get("id"), 80)
        node_id = raw_id or f"n{index + 1}"
        if node_id.lower() in {"root", "unclassified"}:
            node_id = f"n{index + 1}"
        if node_id in used_ids:
            base = node_id
            suffix = 2
            while f"{base}_{suffix}" in used_ids:
                suffix += 1
            node_id = f"{base}_{suffix}"
        used_ids.add(node_id)
        node = {
            "id": node_id,
            "parentId": _clean_name(raw.get("parentId") or raw.get("parent") or "root", 80)
            or "root",
            "label": label,
            "summary": _clean_text(
                raw.get("summary") or raw.get("description"),
                MAX_NODE_SUMMARY,
            ),
            "keywords": _clean_keywords(raw.get("keywords")),
            field_name: get_refs(raw),
            "_raw_relations": raw.get("relations"),
        }
        nodes.append(node)

    nodes = _fix_graph(nodes)
    nodes = _prune_empty(nodes, field_name)
    nodes = _limit_nodes(nodes, max_nodes)
    node_ids = {node["id"] for node in nodes}
    label_to_id: dict[str, str] = {}
    for node in nodes:
        label_to_id.setdefault(node["label"], node["id"])
    for node in nodes:
        node["relations"] = _clean_relations(
            node.pop("_raw_relations", None),
            node_ids,
            node["id"],
            label_to_id,
        )

    # 按从根开始的广度优先顺序输出，保证保存后的文件稳定可读。
    by_parent: dict[str, list[dict]] = {}
    for node in nodes:
        by_parent.setdefault(node["parentId"], []).append(node)
    ordered: list[dict] = []
    queue = list(by_parent.get("root", []))
    while queue:
        node = queue.pop(0)
        ordered.append(node)
        queue.extend(by_parent.get(node["id"], []))
    return ordered


def normalize_ai_knowledge_map(
    payload: dict,
    valid_indexes: set[int],
    max_nodes: int = 60,
) -> dict:
    """校验并归一化 AI 返回的知识图谱；题号使用输入列表中的 1-based 序号。"""
    if not isinstance(payload, dict):
        raise KnowledgeError("AI 返回的知识图谱格式不正确。")
    raw_nodes = _extract_raw_nodes(payload)
    if not raw_nodes:
        raise KnowledgeError("AI 没有返回知识节点，请重试。")
    raw_nodes = _flatten_node_tree(raw_nodes)
    if not raw_nodes:
        raise KnowledgeError("AI 没有返回可用的知识节点，请重试。")

    def get_refs(raw: dict) -> list[int]:
        value = raw.get("questions")
        if value is None:
            value = raw.get("questionIndexes")
        if value is None:
            value = raw.get("questionIds")
        return _clean_index_questions(value, valid_indexes)

    nodes = _finalize_nodes(
        raw_nodes,
        field_name="questions",
        get_refs=get_refs,
        max_nodes=max_nodes,
    )
    if not nodes:
        raise KnowledgeError("AI 没有返回可保存的知识节点，请重试。")
    return {
        "summary": _clean_text(
            payload.get("summary") or payload.get("overview"),
            2000,
        ),
        "nodes": nodes,
    }


def normalize_stored_knowledge_map(
    payload: dict,
    expected_bank_id: str = "",
) -> dict:
    """校验并归一化保存到磁盘的知识图谱 JSON。"""
    if not isinstance(payload, dict):
        raise KnowledgeError("知识图谱内容格式不正确。")
    bank_id = _clean_name(payload.get("bankId"), 200)
    expected = _clean_name(expected_bank_id, 200)
    if expected and bank_id and bank_id != expected:
        raise KnowledgeError("知识图谱与当前子题库不匹配。")
    if not bank_id:
        bank_id = expected
    if not bank_id:
        raise KnowledgeError("知识图谱缺少子题库 ID。")

    def get_refs(raw: dict) -> list[str]:
        value = raw.get("questionIds")
        if value is None:
            value = raw.get("questions")
        return _clean_question_ids(value)

    nodes = _finalize_nodes(
        payload.get("nodes") or [],
        field_name="questionIds",
        get_refs=get_refs,
        max_nodes=MAX_NODES,
    )
    if not nodes:
        raise KnowledgeError("知识图谱没有可保存的节点。")

    try:
        question_count = max(0, int(payload.get("questionCount")))
    except (TypeError, ValueError):
        question_count = 0

    usage = payload.get("usage")
    if not isinstance(usage, dict):
        usage = {}

    return {
        "app": "刷题助手",
        "kind": KNOWLEDGE_KIND,
        "version": KNOWLEDGE_FORMAT,
        "bankId": bank_id,
        "subjectId": _clean_name(payload.get("subjectId"), 200),
        "subjectName": _clean_name(payload.get("subjectName"), 120),
        "bankName": _clean_name(payload.get("bankName"), 120),
        "generatedAt": _clean_name(payload.get("generatedAt"), 80) or _now_iso(),
        "model": _clean_name(payload.get("model"), 240),
        "fingerprint": _clean_name(payload.get("fingerprint"), 80),
        "questionCount": question_count,
        "summary": _clean_text(payload.get("summary"), 2000),
        "nodes": nodes,
        "usage": usage,
    }


def load_knowledge(root: Path, bank_id: str) -> dict | None:
    """读取一个子题库的知识图谱；不存在时返回 None。"""
    path = knowledge_path(root, bank_id)
    if not path.is_file():
        return None
    try:
        if path.stat().st_size > MAX_KNOWLEDGE_BYTES:
            raise KnowledgeError("知识图谱缓存文件过大，已忽略。")
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise KnowledgeError(f"知识图谱缓存读取失败：{exc}") from exc
    if not isinstance(data, dict):
        raise KnowledgeError("知识图谱缓存格式不正确。")
    if _clean_name(data.get("bankId"), 200) != _clean_name(bank_id, 200):
        raise KnowledgeError("知识图谱缓存与当前子题库不匹配。")
    return data


def save_knowledge(root: Path, bank_id: str, payload: dict) -> dict:
    """原子写入一个子题库的知识图谱，返回归一化后的内容。"""
    normalized = normalize_stored_knowledge_map(payload, expected_bank_id=bank_id)
    path = knowledge_path(root, bank_id)
    folder = path.parent
    try:
        folder.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise KnowledgeError(f"无法创建知识图谱目录：{exc}") from exc

    text = json.dumps(normalized, ensure_ascii=False, indent=2) + "\n"
    if len(text.encode("utf-8")) > MAX_KNOWLEDGE_BYTES:
        raise KnowledgeError("知识图谱内容过大，无法保存。")
    temp_path = path.with_suffix(".json.tmp")
    try:
        temp_path.write_text(text, encoding="utf-8")
        os.replace(temp_path, path)
    except OSError as exc:
        try:
            temp_path.unlink()
        except OSError:
            pass
        raise KnowledgeError(f"无法写入知识图谱文件：{exc}") from exc
    return normalized


def cleanup_knowledge(root: Path, valid_bank_ids: set[str]) -> int:
    """删除已不存在的子题库对应的知识图谱 JSON，返回删除数量。"""
    folder = knowledge_dir(root)
    if not folder.is_dir():
        return 0
    valid = {_clean_name(item, 200) for item in valid_bank_ids if _clean_name(item, 200)}
    removed = 0
    for path in folder.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        bank_id = _clean_name(data.get("bankId"), 200)
        if bank_id and bank_id not in valid:
            try:
                path.unlink()
                removed += 1
            except OSError:
                continue
    for temp_path in folder.glob("*.json.tmp"):
        try:
            temp_path.unlink()
        except OSError:
            pass
    return removed

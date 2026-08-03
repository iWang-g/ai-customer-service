from __future__ import annotations

import io
import re
from dataclasses import dataclass


SUPPORTED_EXTENSIONS = {".txt", ".md", ".csv", ".json", ".html", ".docx", ".pdf", ".xlsx", ".xlsm"}


@dataclass(frozen=True)
class ParsedDocument:
    text: str
    file_type: str


@dataclass(frozen=True)
class TextChunk:
    index: int
    title_path: str
    content: str


def _decode_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "gb18030", "utf-16"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def parse_document(filename: str, data: bytes) -> ParsedDocument:
    suffix = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if suffix not in SUPPORTED_EXTENSIONS:
        raise ValueError(f"unsupported file type: {suffix or 'unknown'}")
    if suffix in {".txt", ".md", ".csv", ".json", ".html"}:
        text = _decode_text(data)
    elif suffix == ".docx":
        try:
            from docx import Document
        except ImportError as exc:
            raise ValueError("DOCX 解析依赖未安装，请安装 python-docx") from exc
        document = Document(io.BytesIO(data))
        text = "\n\n".join(paragraph.text.strip() for paragraph in document.paragraphs if paragraph.text.strip())
        for table in document.tables:
            rows = [" | ".join(cell.text.strip() for cell in row.cells) for row in table.rows]
            text += "\n\n" + "\n".join(row for row in rows if row.strip())
    elif suffix == ".pdf":
        try:
            from pypdf import PdfReader
        except ImportError as exc:
            raise ValueError("PDF 解析依赖未安装，请安装 pypdf") from exc
        reader = PdfReader(io.BytesIO(data))
        text = "\n\n".join((page.extract_text() or "").strip() for page in reader.pages).strip()
    else:
        try:
            from openpyxl import load_workbook
        except ImportError as exc:
            raise ValueError("XLSX 解析依赖未安装，请安装 openpyxl") from exc
        workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        sections: list[str] = []
        for sheet in workbook.worksheets:
            sections.append(f"# {sheet.title}")
            for row in sheet.iter_rows(values_only=True):
                values = [str(value).strip() for value in row if value is not None and str(value).strip()]
                if values:
                    sections.append(" | ".join(values))
        text = "\n".join(sections)
    text = re.sub(r"\r\n?", "\n", text).strip()
    if not text:
        raise ValueError("文档没有可解析的文本内容")
    return ParsedDocument(text=text, file_type=suffix.lstrip("."))


def _heading_title(line: str) -> str:
    value = line.strip()
    if re.match(r"^(#{1,6})\s+", value):
        return re.sub(r"^#{1,6}\s+", "", value).strip()
    return ""


def chunk_text(text: str, max_chars: int = 700, overlap_chars: int = 80) -> list[TextChunk]:
    cleaned = re.sub(r"\n{3,}", "\n\n", text.replace("\u00a0", " ")).strip()
    if not cleaned:
        return []
    chunks: list[TextChunk] = []
    current_title = ""
    current_parts: list[str] = []

    def flush() -> None:
        nonlocal current_parts
        content = "\n".join(part for part in current_parts if part.strip()).strip()
        current_parts = []
        if not content:
            return
        start = 0
        while start < len(content):
            end = min(len(content), start + max_chars)
            piece = content[start:end].strip()
            if piece:
                chunks.append(TextChunk(len(chunks), current_title, piece))
            if end >= len(content):
                break
            start = max(0, end - overlap_chars)

    for block in re.split(r"\n\s*\n", cleaned):
        block = block.strip()
        if not block:
            continue
        heading = _heading_title(block) if "\n" not in block else ""
        if heading:
            flush()
            current_title = heading
            continue
        projected = sum(len(part) for part in current_parts) + len(block) + len(current_parts)
        if current_parts and projected > max_chars:
            flush()
        current_parts.append(block)
    flush()
    return chunks

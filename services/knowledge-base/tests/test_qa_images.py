from __future__ import annotations

import io
import unittest

from fastapi import HTTPException
from PIL import Image

from app.service import _normalize_qa_image, save_qa_image


class QaImageTests(unittest.TestCase):
    def test_webp_with_png_name_is_normalized_to_real_png(self) -> None:
        source = io.BytesIO()
        Image.new("RGB", (20, 10), "red").save(source, format="WEBP")

        normalized = _normalize_qa_image(source.getvalue())

        self.assertEqual(normalized[:8], b"\x89PNG\r\n\x1a\n")
        with Image.open(io.BytesIO(normalized)) as image:
            self.assertEqual(image.format, "PNG")
            self.assertEqual(image.size, (20, 10))

    def test_invalid_image_bytes_are_rejected(self) -> None:
        with self.assertRaises(HTTPException) as context:
            save_qa_image("user-image", "answer.png", "image/png", b"not an image")
        self.assertEqual(context.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()

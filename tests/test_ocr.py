import unittest

import server


def box(left, top, right, bottom):
    return [[left, top], [right, top], [right, bottom], [left, bottom]]


class OCRFilterTest(unittest.TestCase):
    def test_low_confidence_answer_letters_are_kept(self):
        self.assertTrue(server._keep_ocr_fragment("C,", 0.49))
        self.assertTrue(server._keep_ocr_fragment("（A）", 0.31))
        self.assertTrue(server._keep_ocr_fragment("Ａ，", 0.47))
        self.assertTrue(server._keep_ocr_fragment("A,C", 0.3))
        self.assertTrue(server._keep_ocr_fragment("正确", 0.3))
        self.assertTrue(server._keep_ocr_fragment("正常文字", 0.5))

    def test_low_confidence_noise_is_dropped(self):
        self.assertFalse(server._keep_ocr_fragment("2", 0.49))
        self.assertFalse(server._keep_ocr_fragment("<", 0.36))
        self.assertFalse(server._keep_ocr_fragment("C,", 0.24))
        self.assertFalse(server._keep_ocr_fragment("普通文字", 0.49))

    def test_answer_letter_is_merged_into_answer_line(self):
        result = [
            [box(50, 100, 220, 140), "正确答案", 0.79],
            [box(230, 101, 255, 138), "C,", 0.49],
            [box(300, 100, 500, 140), "我的答案：C", 0.77],
            [box(10, 50, 25, 80), "2", 0.49],
        ]
        lines = server.boxes_to_lines(result)
        self.assertEqual(len(lines), 1)
        self.assertIn("正确答案", lines[0]["text"])
        self.assertIn("C,我的答案：C", lines[0]["text"])


if __name__ == "__main__":
    unittest.main()

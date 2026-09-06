#!/usr/bin/env python3

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import pymupdf as fitz

from extract_music_links import clean_setting, extract_entries, group_entries


def entry(title, setting, url, page=1, top=10):
    return {
        "title": title,
        "setting": setting,
        "sourceUrl": url,
        "page": page,
        "top": top,
    }


class GroupEntriesTests(unittest.TestCase):
    def test_setting_names_do_not_depend_on_capitalization(self):
        self.assertEqual(clean_setting("(KAZAN)"), "KAZAN")
        self.assertEqual(clean_setting("(Kazan)"), "Kazan")
        self.assertEqual(clean_setting("(Karam)"), "Karam")

    def test_twelve_times_is_the_default_setting(self):
        self.assertEqual(clean_setting("(twelve times)"), "Default")

    def test_twelve_times_uses_the_previous_section_heading(self):
        with TemporaryDirectory() as directory:
            pdf_path = Path(directory) / "service.pdf"
            document = fitz.open()
            page = document.new_page(width=612, height=792)
            page.insert_text((245, 100), "THE INTERCESSION", fontsize=12)
            page.insert_text((220, 300), "Lord, have mercy. (twelve times)", fontsize=12)
            page.insert_link(
                {
                    "kind": fitz.LINK_URI,
                    "from": fitz.Rect(318, 286, 394, 304),
                    "uri": "https://example.com/music.pdf",
                }
            )
            document.save(pdf_path)
            document.close()

            entries = extract_entries(pdf_path)

        self.assertEqual(entries[0]["title"], "THE INTERCESSION")
        self.assertEqual(entries[0]["setting"], "Default")

    def test_groups_settings_on_the_same_printed_line(self):
        grouped = group_entries(
            [
                entry("Resurrectional Apolytikion", "KAZAN", "kazan.pdf"),
                entry("Resurrectional Apolytikion", "CROW", "crow.pdf", top=10.5),
            ]
        )

        self.assertEqual(len(grouped), 1)
        self.assertEqual([link["setting"] for link in grouped[0]["links"]], ["KAZAN", "CROW"])

    def test_keeps_repeated_titles_in_service_order(self):
        grouped = group_entries(
            [
                entry("The Little Litany", "Default", "first.pdf", page=2),
                entry("Kathismata", "Default", "kathismata.pdf", page=3),
                entry("The Little Litany", "Default", "second.pdf", page=4),
                entry("The Little Litany", "Default", "third.pdf", page=4, top=50),
            ]
        )

        self.assertEqual(
            [piece["title"] for piece in grouped],
            ["The Little Litany", "Kathismata", "The Little Litany", "The Little Litany"],
        )
        self.assertEqual(grouped[2]["links"][0]["sourceUrl"], "second.pdf")
        self.assertEqual(grouped[3]["links"][0]["sourceUrl"], "third.pdf")

    def test_same_link_can_appear_in_separate_occurrences(self):
        grouped = group_entries(
            [
                entry("The Little Litany", "Default", "litany.pdf", page=2),
                entry("The Little Litany", "Default", "litany.pdf", page=5),
            ]
        )

        self.assertEqual(len(grouped), 2)
        self.assertEqual([len(piece["links"]) for piece in grouped], [1, 1])
        self.assertEqual(grouped[0]["links"][0]["sourcePage"], 2)
        self.assertEqual(grouped[1]["links"][0]["sourcePage"], 5)

    def test_retains_annotation_location_for_note_link_navigation(self):
        grouped = group_entries(
            [entry("The Little Litany", "KAZAN", "litany.pdf", page=3, top=47.5)]
        )

        link = grouped[0]["links"][0]
        self.assertEqual(link["sourcePage"], 3)
        self.assertEqual(link["sourceTop"], 47.5)


if __name__ == "__main__":
    unittest.main()

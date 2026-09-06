#!/usr/bin/env python3

import unittest

from extract_music_links import group_entries


def entry(title, author, url, page=1, top=10):
    return {
        "title": title,
        "author": author,
        "sourceUrl": url,
        "page": page,
        "top": top,
    }


class GroupEntriesTests(unittest.TestCase):
    def test_groups_settings_on_the_same_printed_line(self):
        grouped = group_entries(
            [
                entry("Resurrectional Apolytikion", "KAZAN", "kazan.pdf"),
                entry("Resurrectional Apolytikion", "CROW", "crow.pdf", top=10.5),
            ]
        )

        self.assertEqual(len(grouped), 1)
        self.assertEqual([link["author"] for link in grouped[0]["links"]], ["KAZAN", "CROW"])

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


if __name__ == "__main__":
    unittest.main()

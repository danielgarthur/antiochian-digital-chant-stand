import unittest
from unittest.mock import Mock

import build_local


class BuildLocalTests(unittest.TestCase):
    def test_extract_client_secret_requires_expected_client_id(self):
        self.assertEqual(
            build_local.extract_client_secret(
                'var config={clientId:"antiochian_api",clientSecret:"current-value"};'
            ),
            "current-value",
        )
        self.assertIsNone(
            build_local.extract_client_secret(
                'var config={clientId:"another_client",clientSecret:"wrong-value"};'
            )
        )

    def test_fetch_client_secret_discovers_bundle_and_skips_third_party_scripts(self):
        page_response = Mock()
        page_response.text = """
            <html><head><base href="/">
            <script src="https://cdn.example/vendor.js"></script>
            <script src="main-CURRENT.js"></script>
            </head></html>
        """
        bundle_response = Mock()
        bundle_response.text = (
            'var environment={production:!0,clientId:"antiochian_api",'
            'clientSecret:"extracted-secret"};'
        )
        session = Mock()
        session.headers = {}
        session.get.side_effect = [page_response, bundle_response]

        self.assertEqual(build_local.fetch_client_secret(session), "extracted-secret")
        self.assertEqual(
            [call.args[0] for call in session.get.call_args_list],
            [
                "https://www.antiochian.org/liturgicday",
                "https://www.antiochian.org/main-CURRENT.js",
            ],
        )


if __name__ == "__main__":
    unittest.main()

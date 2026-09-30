import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from extractHkIpoAllotment import parse_allotment_text


def test_actual_price_date_requires_explicit_past_event():
    result = parse_allotment_text('The Offer Price was determined on 24 September 2026. Final Offer Price HK$8.50.')
    assert result['actualPricingDate'] == '2026-09-24'
    assert result['evidence']['actualPricingDate'] == 'Offer Price was determined on 24 September 2026'
    assert result['finalOfferPrice'] == 8.5
    for text in ['The Offer Price is expected to be determined on 24 September 2026.',
                 'Announcement published on 24 September 2026. Final Offer Price HK$8.50.',
                 'The Offer Price was determined on 31 September 2026.']:
        assert parse_allotment_text(text)['actualPricingDate'] is None


if __name__ == '__main__':
    test_actual_price_date_requires_explicit_past_event()
    print('PASS=1 FAIL=0 ERROR=0')

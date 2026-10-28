"""Plain-text, manager-editable content for the public landing page."""
from django.db import transaction
from django.utils import timezone
from .models import SiteContent

DEFAULTS = {
    "municipality_name": "व्यास नगरपालिका",
    "department_name": "नगर फोहोर व्यवस्थापन विभाग",
    "municipality_location": "दमौली, तनहुँ · गण्डकी प्रदेश, नेपाल",
    "hero_kicker": "स्वच्छ व्यास, स्वस्थ भविष्य",
    "hero_title": "हाम्रो नगर सफा राख्ने साझा प्रयास",
    "hero_body": "नगरका डस्टबिनको अवस्था हेर्नुहोस्, आफ्नो टोलको जानकारी पाउनुहोस् र जिम्मेवार फोहोर व्यवस्थापनमा सहभागी हुनुहोस्।",
    "notice_title": "महत्त्वपूर्ण सूचना",
    "notice_body": "फोहोरलाई कुहिने र नकुहिने गरी छुट्याएर तोकिएको डस्टबिनमा मात्र राख्नुहोस्। डस्टबिन भरिएको वा लामो समयदेखि अफलाइन देखिएमा सम्बन्धित वडा कार्यालयलाई जानकारी दिनुहोस्।",
    "about_title": "यस प्रणालीबारे",
    "about_body": "स्मार्ट डस्टबिनमा जडान गरिएको सेन्सरले भरिएको स्तर नियमित रूपमा पठाउँछ। व्यवस्थापन टोलीले अवस्थाको अनुगमन गरी आवश्यक परेमा संकलन कार्य कर्मचारीलाई तोक्छ। अफलाइन अवस्थाले पछिल्लो ३० सेकेन्डमा नयाँ मापन नआएको जनाउँछ।",
    "awareness_title": "फोहोर व्यवस्थापन सचेतना",
    "awareness_body": "घरमै कुहिने र नकुहिने फोहोर छुट्याउनुहोस्।\nसार्वजनिक स्थान र नालीमा फोहोर नफाल्नुहोस्।\nडस्टबिन भरिएको भए नजिकै फोहोर थुपार्नुको सट्टा स्थानीय कार्यालयलाई जानकारी दिनुहोस्।",
    "lookup_title": "आफ्नो टोलको डस्टबिन अवस्था जाँच्नुहोस्",
    "lookup_help": "टोलको नाम लेखेर खोज्नुहोस्। खोजमा देखिएको स्तर पछिल्लो उपलब्ध सेन्सर मापन हो।",
    "footer_text": "व्यास नगरपालिका · नगर फोहोर व्यवस्थापन विभाग",
}

LIMITS = {key: (2000 if key.endswith("_body") else 160) for key in DEFAULTS}


def public_content():
    return DEFAULTS | {record.key: record.value for record in SiteContent.objects.filter(key__in=DEFAULTS)}


def save_content(payload):
    if not isinstance(payload, dict) or not payload or any(key not in DEFAULTS for key in payload):
        raise ValueError("Unknown or missing content field")
    cleaned = {}
    for key, value in payload.items():
        if not isinstance(value, str) or not value.strip() or len(value) > LIMITS[key]:
            raise ValueError(f"Invalid value for {key}")
        cleaned[key] = value.strip()
    with transaction.atomic():
        for key, value in cleaned.items():
            SiteContent.objects.update_or_create(key=key, defaults={"value": value, "updated_at": timezone.now()})
    return public_content()

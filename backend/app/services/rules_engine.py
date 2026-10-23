"""
Configurable Rule-Based Scam Detection Engine.
- Supports English, Hindi (Devanagari & Romanized), Punjabi (Gurmukhi & Romanized), and mixed speech.
- Accounts for negation, sentence meaning, and protective advice ("Never share your OTP",
  "Send me your QR so I can pay you").
- Never classifies a call based solely on isolated single-word matches without action/solicitation context.
- Avoids counting duplicate evidence within a transcript or across segments of the same call.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Set, Tuple
from app.core.config import DEFAULT_RULE_WEIGHTS, Settings, get_settings
from app.schemas.analysis import RuleEngineResult, TriggeredIndicator
from app.services.keyword_sync_service import KeywordSyncService, get_keyword_sync_service


@dataclass(frozen=True)
class RulePatternDef:
    rule_id: str
    category: str
    pattern_label: str
    phrases: Tuple[str, ...]
    explanation: str
    regex: Optional[re.Pattern] = None


# Protective / negation / legitimate expressions that MUST NOT be flagged as scam requests
PROTECTIVE_OR_LEGITIMATE_PATTERNS: Tuple[Tuple[str, str], ...] = (
    # English protective advice
    ("never share your otp", "Protective advice warning against sharing OTP"),
    ("never share otp", "Protective advice warning against sharing OTP"),
    ("do not share your otp", "Protective advice warning against sharing OTP"),
    ("don't share your otp", "Protective advice warning against sharing OTP"),
    ("do not share otp", "Protective advice warning against sharing OTP"),
    ("never share your pin", "Protective advice warning against sharing PIN"),
    ("never share your password", "Protective advice warning against sharing password"),
    ("never enter your upi pin to receive", "Protective advice explaining UPI PIN is only for sending"),
    ("bank will never ask for your otp", "Official bank security reminder"),
    ("bank employees will never ask for your otp", "Official bank security reminder"),
    ("never ask for your otp", "Official security reminder"),
    ("bank employees never ask for pin", "Official bank security reminder"),
    ("we will never ask for your password", "Official security reminder"),
    ("never click on unknown links", "Protective security advice against malicious links"),
    ("do not click on suspicious links", "Protective security advice against phishing links"),
    ("never install anydesk", "Protective advice against installing remote access tools"),
    ("digital arrest is a fraud", "Protective advice warning about digital arrest scam"),
    ("police never arrests over video call", "Protective security explanation"),
    # Hindi protective advice (Romanized & Devanagari)
    ("kabhi bhi kisi ko otp mat batana", "Hindi protective advice against sharing OTP"),
    ("kisi ko otp mat batana", "Hindi protective advice against sharing OTP"),
    ("otp mat batana", "Hindi protective advice against sharing OTP"),
    ("pin mat batana", "Hindi protective advice against sharing PIN"),
    ("kisi ke saath otp share na karein", "Hindi protective advice"),
    ("kisi link par click mat karna", "Hindi protective advice against links"),
    ("anydesk install mat karna", "Hindi protective advice against remote tools"),
    ("ओटीपी मत बताना", "Hindi protective advice in Devanagari"),
    ("कभी भी ओटीपी साझा न करें", "Hindi protective advice in Devanagari"),
    ("पिन मत डालें", "Hindi protective advice in Devanagari"),
    ("किसी लिंक पर क्लिक न करें", "Hindi protective advice in Devanagari"),
    # Punjabi protective advice (Romanized & Gurmukhi)
    ("kise nu otp na dasso", "Punjabi protective advice against sharing OTP"),
    ("otp na dasso", "Punjabi protective advice against sharing OTP"),
    ("ਓਟੀਪੀ ਨਾ ਦੱਸੋ", "Punjabi protective advice in Gurmukhi"),
    ("ਕਦੇ ਵੀ ਓਟੀਪੀ ਸਾਂਝਾ ਨਾ ਕਰੋ", "Punjabi protective advice in Gurmukhi"),
    # Legitimate buyer asking seller for seller's QR or UPI ID so buyer can pay seller
    ("send me your qr", "Legitimate payer asking for payee's QR code to send payment"),
    ("can you send me your qr", "Legitimate payer asking for payee's QR code"),
    ("share your qr so i can pay", "Legitimate payer asking for payee's QR code"),
    ("send me your upi id", "Legitimate payer asking for UPI ID"),
    ("share your upi id so i can pay", "Legitimate payer asking for UPI ID"),
    ("aapka upi id bhej do main pay kar", "Legitimate payer asking for UPI ID to pay"),
    ("apna qr bhej do main payment kar", "Legitimate payer asking for QR to pay"),
    ("apna qr bhejo main paise bhejta hoon", "Legitimate payer asking for QR to pay"),
    ("apna bank account bhejo payment karne ke liye", "Legitimate payer asking for account to pay"),
    # Legitimate customer banking queries & requests
    ("check my balance", "Legitimate customer balance inquiry"),
    ("account balance inquiry", "Legitimate customer balance inquiry"),
    ("mera balance kitna hai", "Legitimate customer balance inquiry in Hindi"),
    ("mera account balance check karna", "Legitimate customer balance check in Hindi"),
    ("khate da balance dasso", "Legitimate customer balance check in Punjabi"),
    ("mini statement nikalna hai", "Legitimate customer mini statement request"),
    ("account statement bhej do", "Legitimate customer statement request"),
    ("passbook update karwani hai", "Legitimate customer passbook update inquiry"),
    ("visit nearest branch", "Legitimate bank recommendation to visit physical branch"),
    ("visit your branch with documents", "Legitimate branch visit guidance"),
    ("branch aakar kyc karwa lijiye", "Legitimate guidance to visit branch in person"),
    ("atm jaakar pin change karein", "Legitimate advice to use official ATM for PIN change"),
    # Automated system OTP delivery and transaction notifications (inbound, non-solicitation)
    ("your otp for logging into your account is", "Automated system OTP delivery notification"),
    ("your otp for logging in is", "Automated system OTP delivery notification"),
    ("your otp for transaction is", "Automated system OTP delivery notification"),
    ("your one time password is", "Automated system OTP delivery notification"),
    ("is your secret otp", "Automated system OTP delivery notification"),
)


REGEX_OTP_SOLICITATION = re.compile(
    r"\b(what is|whats|batao|bata|dasso|das|share|tell|give|enter|send|provide|input|type|confirm|verify|daalo|daal|bhejo|bhej|likho|bolo|read out|boliye|bataiye|need|asking|asking for)\b.*?\b(otp|pin|upi pin|password|passcode|cvv|code|verification code|sensitive info|sensitive information|sensitive data|sensitive details|bank details|banking details|account details|card details|credentials|login credentials|confidential info|confidential details)\b"
    r"|\b(otp|pin|upi pin|password|passcode|cvv|code|verification code|sensitive info|sensitive information|sensitive data|sensitive details|bank details|banking details|account details|card details|credentials)\b.*?\b(batao|bata|dasso|das|share|tell|give|enter|send|provide|daalo|daal|bhejo|bhej|likho|bolo|chahiye|de do|bata do|dass do|verify|confirm|karo|bataiye|needed|required)\b"
    r"|\b(?:asking|demanding|requesting|soliciting)\s+(?:for\s+)?sensitive\s+(?:info|information|details|data|credentials)\b"
    r"|(?:ओटीपी|पिन|पासवर्ड|सीवीवी|संवेदनशील\s+जानकारी|बैंक\s+विवरण).*(?:बताओ|बताइए|डालो|दीजिए|भेजो|शेयर)|(?:बताओ|बताइए|डालो|दीजिए|भेजो|शेयर).*(?:ओटीपी|पिन|पासवर्ड|सीवीवी|संवेदनशील\s+जानकारी|बैंक\s+विवरण)"
    r"|(?:ਓਟੀਪੀ|ਪਿੰਨ).*(?:ਦੱਸੋ|ਦੱਸ|ਪਾਓ|ਭੇਜੋ)|(?:ਦੱਸੋ|ਦੱਸ|ਪਾਓ|ਭੇਜੋ).*(?:ਓਟੀਪੀ|ਪਿੰਨ)",
    re.IGNORECASE,
)

# Banking secrets and details a genuine caller never needs, in English, Hindi and Punjabi.
# Speech-to-text often writes English banking words in Devanagari or Gurmukhi ("ओटीपी", "ਕਾਰਡ ਨੰਬਰ").
# A bare "pin" is left out on purpose ("pin code" is a postal code).
SENSITIVE_TERMS_EN = (
    r"otp|one time password|cvv|cvc|upi pin|atm pin|mpin|m pin|pin number|secret pin"
    r"|card number|card no|card details|debit card|credit card|card expiry|expiry date"
    r"|account number|account no|account details|bank details|banking details|bank account number"
    r"|net banking|netbanking|internet banking|banking password|login password|bank password"
    r"|verification code|security code|aadhaar number|aadhar number|pan number"
)
SENSITIVE_TERMS_HI = (
    r"ओटीपी|ओ टी पी|सीवीवी|यूपीआई पिन|एटीएम पिन|पिन नंबर|एमपिन"
    r"|कार्ड नंबर|कार्ड नम्बर|कार्ड डिटेल|डेबिट कार्ड|क्रेडिट कार्ड|एक्सपायरी"
    r"|अकाउंट नंबर|अकाउंट नम्बर|खाता नंबर|खाता संख्या|बैंक डिटेल|बैंक विवरण|अकाउंट डिटेल"
    r"|नेट बैंकिंग|पासवर्ड|वेरिफिकेशन कोड|आधार नंबर"
)
SENSITIVE_TERMS_PA = (
    r"ਓਟੀਪੀ|ਸੀਵੀਵੀ|ਪਿੰਨ ਨੰਬਰ|ਕਾਰਡ ਨੰਬਰ|ਡੈਬਿਟ ਕਾਰਡ|ਕ੍ਰੈਡਿਟ ਕਾਰਡ"
    r"|ਅਕਾਊਂਟ ਨੰਬਰ|ਖਾਤਾ ਨੰਬਰ|ਬੈਂਕ ਡਿਟੇਲ|ਪਾਸਵਰਡ"
)

REGEX_SENSITIVE_MENTION = re.compile(
    rf"\b(?:{SENSITIVE_TERMS_EN})\b|(?:{SENSITIVE_TERMS_HI})|(?:{SENSITIVE_TERMS_PA})",
    re.IGNORECASE,
)

# An ask for one of those terms ("tell me your CVV", "card number batao", "MPIN kya hai aapka",
# "कार्ड नंबर बताइए", "ਓਟੀਪੀ ਦੱਸੋ"), in either word order.
_ASK_BEFORE_EN = (
    r"read me|read out|read|tell me|tell|share|give me|give|send me|send|provide|confirm|verify"
    r"|what is your|whats your|what s your|what is the|can you tell|i need|need your"
    r"|batao|bata do|bata dijiye|bataiye|bolo|boliye|dijiye|de do|de dijiye|bhej do|bhejo|dasso|das do"
)
_ASK_AFTER_EN = (
    r"batao|bata do|bata dijiye|bataiye|bolo|boliye|dijiye|de do|de dijiye|bhej do|bhejo|dasso|das do"
    r"|kya hai|kitna hai|please|chahiye|share karo|send karo|bhejiye"
)
_ASK_HI = r"बताओ|बताइए|बताइये|बता दीजिए|बता दो|दीजिए|दे दो|भेजो|भेज दो|भेजिए|डालो|बोलिए|बोलो|शेयर करो|शेयर कीजिए|क्या है"
_ASK_PA = r"ਦੱਸੋ|ਦੱਸ ਦਿਓ|ਦਸੋ|ਭੇਜੋ|ਪਾਓ|ਦਿਓ|ਕੀ ਹੈ"
_TERMS_OR_CODE_EN = rf"{SENSITIVE_TERMS_EN}|code|pin|password|passcode"

REGEX_SENSITIVE_SOLICITATION = re.compile(
    rf"\b(?:{_ASK_BEFORE_EN})\b.*?\b(?:{_TERMS_OR_CODE_EN})\b"
    rf"|\b(?:{SENSITIVE_TERMS_EN})\b.*?\b(?:{_ASK_AFTER_EN})\b"
    rf"|(?:{SENSITIVE_TERMS_HI}|कोड|पिन).*?(?:{_ASK_HI})|(?:{_ASK_HI}).*?(?:{SENSITIVE_TERMS_HI})"
    rf"|(?:{SENSITIVE_TERMS_PA}|ਪਿੰਨ|ਕੋਡ).*?(?:{_ASK_PA})|(?:{_ASK_PA}).*?(?:{SENSITIVE_TERMS_PA})",
    re.IGNORECASE,
)

# Generic safety advice ("never share your CVV", "don't give your card number to anyone",
# "bank never asks for your PIN"). Paired with POSITIVE_ASK so "don't tell anyone, just tell me the
# OTP" is still treated as an ask.
REGEX_PROTECTIVE_ADVICE = re.compile(
    # The "never/don't" must govern the banking word itself: up to three words in between, none of
    # them another verb, so "don't tell anyone, give your card number" is not read as advice.
    rf"\b(?:never|do not|don't|don t|dont|not)\s+(?:share|give|tell|disclose|reveal|send)\s+"
    rf"(?:(?!share\b|give\b|tell\b|send\b|read\b|batao\b)\w+\s+){{0,3}}(?:{_TERMS_OR_CODE_EN})\b"
    rf"|\bnever\s+asks?\s+(?:you\s+)?for\b"
    rf"|\b(?:{SENSITIVE_TERMS_EN}|code|pin|password)\b.*?\b(?:mat batana|mat bataiye|mat bataye|mat dena|share na karein|na dasso)\b"
    rf"|(?:{SENSITIVE_TERMS_HI}|कोड|पिन).*?(?:मत बताइए|मत बताना|मत बताएं|मत दीजिए|न बताएं|साझा न करें|शेयर न करें)"
    rf"|(?:{SENSITIVE_TERMS_PA}|ਪਿੰਨ|ਕੋਡ).*?(?:ਨਾ ਦੱਸੋ|ਨਾ ਦਸੋ|ਸਾਂਝਾ ਨਾ ਕਰੋ)",
    re.IGNORECASE,
)
REGEX_ANY_SENSITIVE_SOLICITATION = re.compile(
    rf"(?:{REGEX_OTP_SOLICITATION.pattern})|(?:{REGEX_SENSITIVE_SOLICITATION.pattern})",
    re.IGNORECASE,
)
POSITIVE_ASK = re.compile(
    r"\b(?:tell me|give me|send me|read me|share it with me|ab otp batao|mujhe batao|mujhe bata do|tell me the code)\b"
    r"|मुझे बताओ|मुझे बताइए|मुझे बता दीजिए|ਮੈਨੂੰ ਦੱਸੋ",
    re.IGNORECASE,
)

REGEX_ACCOUNT_SUSPENSION = re.compile(
    r"\b(account|khata|sim|sim card|card|bank account|kyc|electricity|debit card)\b.*?\b(block|blocked|suspend|suspended|freeze|frozen|deactivate|band|expired|disconnect|disconnected)\b"
    r"|\b(block|blocked|suspend|suspended|freeze|frozen|deactivate|band)\b.*?\b(account|khata|sim|card|kyc)\b"
    r"|(?:खाता|अकाउंट|सिम|केवाईसी).*(?:बंद|ब्लॉक|सस्पेंड|फ्रीज)|(?:बंद|ब्लॉक|सस्पेंड|फ्रीज).*(?:खाता|अकाउंट|सिम|केवाईसी)"
    r"|(?:ਖਾਤਾ|ਅਕਾਊਂਟ|ਸਿਮ).*(?:ਬੰਦ|ਬਲਾਕ)|(?:ਬੰਦ|ਬਲਾਕ).*(?:ਖਾਤਾ|ਅਕਾਊਂਟ|ਸਿਮ)",
    re.IGNORECASE,
)

REGEX_REMOTE_ACCESS = re.compile(
    r"\b(download|install|open|chalao|khol|share screen|screen share)\b.*?\b(anydesk|teamviewer|quicksupport|rustdesk|screen share)\b"
    r"|\b(anydesk|teamviewer|quicksupport|rustdesk)\b.*?\b(download|install|open|karo|daalo|kar lo)\b",
    re.IGNORECASE,
)

REGEX_QR_LURE = re.compile(
    r"\b(scan|scanner)\b.*?\b(qr|qr code)\b.*?\b(receive|money|paise|payment|credit)\b"
    r"|\b(qr|qr code)\b.*?\b(scan|scanner)\b.*?\b(paise|payment|receive|aayenge|aa jayega)\b",
    re.IGNORECASE,
)

REGEX_LEGAL_THREAT = re.compile(
    r"\b(digital arrest|arrest warrant|non bailable|cbi|police station|narcotics bureau|crime branch|cyber crime|fir filed|customs seizure)\b",
    re.IGNORECASE,
)

REGEX_URGENT_PAYMENT = re.compile(
    r"\b(transfer|send|pay|deposit|bhejo|jama karo|transfer karo)\b.*?\b(money|paise|funds|amount|deposit|fee|charge|account)\b"
    r"|\b(money|paise|funds|fee)\b.*?\b(transfer|send|pay|deposit|bhejo|jama)\b"
    r"|(?:पैसे|रुपये|राशि).*(?:ट्रांसफर|भेजो|डालो|पे|जमा)|(?:ट्रांसफर|भेजो|डालो|पे|जमा).*(?:पैसे|रुपये|राशि)",
    re.IGNORECASE,
)

REGEX_URGENCY_PRESSURE = re.compile(
    r"\b(?:within|in)\s+\d+\s+(?:minute|minutes|min|mins|second|seconds|ghante|ghanta)\b"
    r"|\b\d+\s+(?:minute|min|ghante)\s+(?:ke andar|mein)\b"
    r"|\b(?:immediately|right now|turant|jaldi|urgent|urgently|warna|otherwise|unless you)\b"
    r"|(?:तुरंत|जल्दी|वरना|\d+\s*मिनट के अंदर)",
    re.IGNORECASE,
)


RULE_DEFINITIONS: Tuple[RulePatternDef, ...] = (
    RulePatternDef(
        rule_id="RULE_OTP_PIN_SOLICITATION",
        category="OTP_OR_PIN_REQUEST",
        pattern_label="otp_or_pin_solicitation",
        regex=REGEX_ANY_SENSITIVE_SOLICITATION,
        phrases=(
            "share the otp",
            "share your otp",
            "share otp",
            "tell me the otp",
            "tell me your otp",
            "tell me the code",
            "tell me your code",
            "give me the otp",
            "give me your otp",
            "read out the otp",
            "send the verification code",
            "enter your upi pin",
            "enter your pin",
            "tell me your pin",
            "tell me your upi pin",
            "tell me the upi pin",
            "share your upi pin",
            "share your password",
            "tell me your cvv",
            "otp batao",
            "otp bata do",
            "code batao",
            "apna upi pin daal",
            "upi pin daal do",
            "pin daalo",
            "pin daal do",
            "otp dasso",
            "mainu dasso",
            "tuhade phone te otp aaya",
            "asking sensitive info",
            "asking for sensitive info",
            "asking for sensitive information",
            "asking sensitive information",
            "share your sensitive info",
            "share sensitive info",
            "give me your sensitive info",
            "tell me your sensitive info",
            "provide your sensitive info",
            "give me sensitive info",
            "share sensitive information",
            "give me your bank details",
            "share your bank details",
            "give me your account details",
            "share your account details",
            "give me your card details",
            "share your card details",
            "tell me your card number",
            "share your credentials",
            "give me your credentials",
            "ओटीपी बताओ",
            "ओटीपी बता दीजिए",
            "यूपीआई पिन डालो",
            "अपना पिन डालें",
            "ਓਟੀਪੀ ਦੱਸੋ",
            "ਪਿੰਨ ਪਾਓ",
        ),
        explanation="Caller explicitly requested an OTP, verification code, UPI PIN, CVV, password, sensitive information, or banking credentials.",
    ),
    RulePatternDef(
        rule_id="RULE_QR_SCAN_RECEIVE_LURE",
        category="QR_SCAN_TO_RECEIVE_MONEY",
        pattern_label="qr_scan_to_receive",
        regex=REGEX_QR_LURE,
        phrases=(
            "scan it and the money comes",
            "scan this qr code to receive",
            "scan qr to receive",
            "scan the qr code to get",
            "sending you a qr code just scan",
            "qr bhej raha hoon scan karo",
            "qr scan karo payment",
            "scan karo payment turant",
            "scan karo paise aa jaange",
            "qr bhej reha haan scan karo",
            "bas qr scan kar lo",
            "क्यूआर स्कैन करो पैसे",
            "स्कैन करो पेमेंट आ जाएगा",
            "ਕਿਊਆਰ ਸਕੈਨ ਕਰੋ ਪੈਸੇ ਆ ਜਾਣਗੇ",
            "ਸਕੈਨ ਕਰੋ ਪੈਸੇ",
        ),
        explanation="Caller asked the recipient to scan a QR code under the false claim of receiving money.",
    ),
    RulePatternDef(
        rule_id="RULE_REMOTE_ACCESS_APP",
        category="REMOTE_ACCESS_OR_SCREEN_SHARE",
        pattern_label="remote_access_screen_share",
        regex=REGEX_REMOTE_ACCESS,
        phrases=(
            "install anydesk",
            "download anydesk",
            "anydesk app",
            "teamviewer",
            "quicksupport",
            "rustdesk",
            "share your screen",
            "enable screen sharing",
            "screen share karo",
            "anydesk download karo",
            "install this apk",
            "स्क्रीन शेयर करो",
            "एनीडेस्क डाउनलोड",
            "ਸਕ੍ਰੀਨ ਸ਼ੇਅਰ ਕਰੋ",
        ),
        explanation="Caller asked the user to install a remote-access tool or share their screen.",
    ),
    RulePatternDef(
        rule_id="RULE_ARREST_OR_LEGAL_THREAT",
        category="THREAT_ARREST_OR_LEGAL_ACTION",
        pattern_label="arrest_or_legal_threat",
        regex=REGEX_LEGAL_THREAT,
        phrases=(
            "digital arrest",
            "arrest warrant",
            "non bailable warrant",
            "police will arrest you",
            "fir registered against your aadhaar",
            "cbi investigation",
            "enforcement directorate notice",
            "money laundering case",
            "supreme court warrant",
            "jail ho jayegi",
            "police abhi aayegi",
            "डिजिटल अरेस्ट",
            "गिरफ्तारी वारंट",
            "पुलिस केस",
            "ਗ੍ਰਿਫਤਾਰੀ ਵਾਰੰਟ",
            "ਪੁਲਿਸ ਕੇਸ",
        ),
        explanation="Caller threatened arrest, warrants, CBI/ED investigation, or criminal legal action.",
    ),
    RulePatternDef(
        rule_id="RULE_ACCOUNT_SUSPENSION_THREAT",
        category="ACCOUNT_SUSPENSION_THREAT",
        pattern_label="account_or_kyc_block_threat",
        regex=REGEX_ACCOUNT_SUSPENSION,
        phrases=(
            "account will be blocked",
            "account will be suspended",
            "account has been frozen",
            "sim card will be blocked",
            "kyc expired account block",
            "electricity connection will be disconnected",
            "khata band ho jayega",
            "account block ho jayega",
            "kyc band ho gaya",
            "खाता बंद हो जाएगा",
            "अकाउंट ब्लॉक हो जाएगा",
            "ਖਾਤਾ ਬੰਦ ਹੋ ਜਾਵੇਗਾ",
        ),
        explanation="Caller threatened immediate bank account freeze, SIM deactivation, or KYC suspension.",
    ),
    RulePatternDef(
        rule_id="RULE_AUTHORITY_IMPERSONATION",
        category="AUTHORITY_OR_BANK_IMPERSONATION",
        pattern_label="authority_or_bank_impersonation",
        phrases=(
            "calling from rbi",
            "reserve bank officer",
            "cyber crime branch",
            "customs officer speaking",
            "narcotics bureau",
            " calling from bank head office",
            "main army mein hoon",
            "cisf officer",
            "main system bol raha hoon",
            "ये कॉल वेरीफाइड है",
            "आरबीआई से बोल रहा हूँ",
            "साइबर क्राइम विभाग",
            "ਮੈਂ ਆਰਮੀ ਵਿੱਚ ਹਾਂ",
        ),
        explanation="Caller claimed authority status (RBI, bank security, customs, cyber cell, or military/system).",
    ),
    RulePatternDef(
        rule_id="RULE_URGENT_PAYMENT_DEMAND",
        category="URGENT_PAYMENT_DEMAND",
        pattern_label="urgent_payment_or_fee",
        regex=REGEX_URGENT_PAYMENT,
        phrases=(
            "pay the processing fee immediately",
            "transfer the security deposit now",
            "pay customs duty right now",
            "refundable verification charge",
            "transfer money to this account",
            "transfer money",
            "transfer the money",
            "send money to this account",
            "send money",
            "pay money",
            "deposit money",
            "abhi turant paise bhejo",
            "processing fee jama karo",
            "turant transfer karo",
            "तुरंत पैसे भेजो",
            "प्रोसेसिंग फीस जमा करें",
            "ਹੁਣੇ ਪੈਸੇ ਭੇਜੋ",
        ),
        explanation="Caller demanded an urgent upfront fee, deposit, or immediate money transfer.",
    ),
    RulePatternDef(
        rule_id="RULE_PRESSURE_TACTICS",
        category="PRESSURE_AND_SECRECY_TACTIC",
        pattern_label="urgency_or_secrecy_pressure",
        regex=REGEX_URGENCY_PRESSURE,
        phrases=(
            "do not disconnect the call",
            "don't tell anyone",
            "tell me the code quickly",
            "do it within 2 minutes",
            "in 5 minutes",
            "within 5 minutes",
            "in 10 minutes",
            "right now",
            "immediately",
            "unless you transfer",
            "warna account",
            "jaldi batao",
            "call mat kaatna",
            "kisi ko mat batana",
            "alert band karo",
            "कॉल मत काटना",
            "जल्दी बताओ",
            "ਕਾਲ ਨਾ ਕੱਟੋ",
            "ਜਲਦੀ ਦੱਸੋ",
        ),
        explanation="Caller used high-pressure urgency, secrecy demands, or prompt-injection commands.",
    ),
    RulePatternDef(
        rule_id="RULE_SUSPICIOUS_LINK_OR_APK",
        category="SUSPICIOUS_LINK_OR_APK",
        pattern_label="suspicious_link_or_apk",
        phrases=(
            "click this link",
            "click on the link",
            "open the link",
            "link par click karo",
            "link pe click karo",
            "link click karo",
            "sms mein link bheja",
            "whatsapp te link bhejea",
            "whatsapp par link bheja",
            "link open karo",
            "download the apk",
            "install this apk",
            "apk download karo",
            "apk install karo",
            "apk file bheji hai",
            "ਲਿੰਕ ਤੇ ਕਲਿੱਕ ਕਰੋ",
            "ਲਿੰਕ ਖੋਲ੍ਹੋ",
            "ਏਪੀਕੇ ਇੰਸਟਾਲ ਕਰੋ",
            "लिंक पर क्लिक करें",
            "लिंक ओपन करें",
            "एपीके डाउनलोड",
        ),
        explanation="Caller asked the user to click a suspicious link or install an unverified APK.",
    ),
    # Kept last: only counts when the same clause has no explicit ask (see RulesEngine.evaluate).
    RulePatternDef(
        rule_id="RULE_SENSITIVE_DETAIL_MENTION",
        category="SENSITIVE_DETAIL_MENTION",
        pattern_label="sensitive_banking_detail_mention",
        regex=REGEX_SENSITIVE_MENTION,
        phrases=(),
        explanation="Caller brought up an OTP, CVV, PIN, card, account or net-banking detail that a genuine caller never needs.",
    ),
)


def normalise_text(raw: str) -> str:
    """Lowercases and normalises whitespace while keeping Latin, Devanagari, and Gurmukhi scripts."""
    if not raw:
        return ""
    cleaned = re.sub(r"[^\w\s\u0900-\u097F\u0A00-\u0A7F']", " ", raw.lower())
    return re.sub(r"\s+", " ", cleaned).strip()


class RulesEngine:
    """
    Configurable Rule-Based Scam Detection Engine.
    Evaluates normalized clauses, suppresses negated/protective advice, deduplicates evidence,
    and checks cross-call synchronized keywords.
    """

    def __init__(
        self,
        settings: Optional[Settings] = None,
        keyword_sync_service: Optional[KeywordSyncService] = None,
        custom_weights: Optional[Dict[str, float]] = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.keyword_sync = keyword_sync_service or get_keyword_sync_service()
        self.weights: Dict[str, float] = dict(DEFAULT_RULE_WEIGHTS)
        self.weights.update(self.settings.rule_weights)
        if custom_weights:
            self.weights.update(custom_weights)

    def evaluate(
        self,
        transcript: str,
        *,
        start_seconds: Optional[float] = None,
        end_seconds: Optional[float] = None,
        already_seen_keys: Optional[Set[str]] = None,
        call_id: Optional[str] = None,
    ) -> Tuple[RuleEngineResult, Set[str]]:
        """
        Analyses `transcript` and returns `(RuleEngineResult, updated_seen_keys)`.
        Never classifies based solely on isolated single keywords without solicitation context.
        """
        seen: Set[str] = set(already_seen_keys) if already_seen_keys else set()
        if not transcript or not transcript.strip():
            return RuleEngineResult(), seen

        # Split transcript into sentence/clause chunks so protective negation in one clause
        # is evaluated accurately without masking an attack in a separate sentence (e.g. prompt injection).
        raw_clauses = [
            c.strip()
            for c in re.split(r"[.!?\n;।]+", transcript)
            if c.strip()
        ]
        if not raw_clauses:
            raw_clauses = [transcript.strip()]

        triggered: List[TriggeredIndicator] = []
        suppressed_protective: List[str] = []
        synced_matched: List[str] = []
        duplicate_count = 0

        for clause in raw_clauses:
            norm_clause = normalise_text(clause)
            if not norm_clause:
                continue

            # 1. Check if this clause is protective advice or a legitimate buyer payment offer
            # Advice only counts as advice when the same clause isn't also asking ("don't tell
            # anyone, just tell me the OTP").
            asks_anyway = bool(POSITIVE_ASK.search(norm_clause))
            matched_protective = False
            if not asks_anyway:
                for prot_phrase, prot_reason in PROTECTIVE_OR_LEGITIMATE_PATTERNS:
                    if normalise_text(prot_phrase) in norm_clause:
                        suppressed_protective.append(f"{prot_phrase} ({prot_reason})")
                        matched_protective = True
                        break
                if not matched_protective:
                    advice = REGEX_PROTECTIVE_ADVICE.search(norm_clause)
                    if advice:
                        suppressed_protective.append(f"{advice.group(0).strip()} (Protective advice about banking secrets)")
                        matched_protective = True

            if matched_protective:
                continue

            clause_categories: Set[str] = set()

            # 2. Evaluate structured rule definitions on this clause
            for rule_def in RULE_DEFINITIONS:
                # A mention adds nothing when the same clause already asks for the detail.
                if rule_def.category == "SENSITIVE_DETAIL_MENTION" and "OTP_OR_PIN_REQUEST" in clause_categories:
                    continue
                matched_keyword: Optional[str] = None

                # A. Check regex pattern if available
                if rule_def.regex is not None:
                    m = rule_def.regex.search(norm_clause)
                    if m:
                        matched_keyword = m.group(0).strip()

                # B. Check exact phrase catalog
                if not matched_keyword:
                    for phrase in rule_def.phrases:
                        norm_phrase = normalise_text(phrase)
                        if norm_phrase and norm_phrase in norm_clause:
                            matched_keyword = phrase
                            break

                if matched_keyword:
                    clause_categories.add(rule_def.category)
                    dedup_key = f"{rule_def.rule_id}:{rule_def.pattern_label}"
                    if dedup_key in seen:
                        duplicate_count += 1
                        continue

                    seen.add(dedup_key)
                    raw_w = float(self.weights.get(rule_def.category, 30.0))
                    weight = raw_w * 100.0 if 0.0 < raw_w <= 1.0 else raw_w
                    triggered.append(
                        TriggeredIndicator(
                            rule_id=rule_def.rule_id,
                            category=rule_def.category,
                            keyword_or_pattern=matched_keyword,
                            weight=weight,
                            excerpt=clause[:200],
                            start_seconds=start_seconds,
                            end_seconds=end_seconds,
                            synced_across_calls=False,
                            explanation=rule_def.explanation,
                        )
                    )
                    # Sync high-signal phrase to cross-call KeywordSyncService if call_id provided
                    if call_id and weight >= 40.0:
                        self.keyword_sync.register_or_sync_keyword(
                            keyword=normalise_text(matched_keyword),
                            category=rule_def.category,
                            weight=min(40.0, weight),
                            source_call_id=call_id,
                        )

            # 3. Check cross-call synchronized keywords
            for sync_entry in self.keyword_sync.get_active_keywords():
                norm_kw = normalise_text(sync_entry.keyword)
                if not norm_kw or norm_kw not in norm_clause:
                    continue
                dedup_key = f"SYNC:{norm_kw}"
                if dedup_key in seen:
                    continue
                # Avoid double-counting if the exact same category was already triggered on this clause
                if any(t.category == sync_entry.category and t.excerpt == clause[:200] for t in triggered):
                    synced_matched.append(sync_entry.keyword)
                    seen.add(dedup_key)
                    continue

                seen.add(dedup_key)
                synced_matched.append(sync_entry.keyword)
                raw_sync_w = float(self.weights.get("CROSS_CALL_SYNCED_KEYWORD", sync_entry.weight))
                sync_w = raw_sync_w * 100.0 if 0.0 < raw_sync_w <= 1.0 else raw_sync_w
                triggered.append(
                    TriggeredIndicator(
                        rule_id="RULE_CROSS_CALL_SYNC",
                        category=sync_entry.category,
                        keyword_or_pattern=sync_entry.keyword,
                        weight=sync_w,
                        excerpt=clause[:200],
                        start_seconds=start_seconds,
                        end_seconds=end_seconds,
                        synced_across_calls=True,
                        explanation=f"Matched cross-call synchronized scam indicator '{sync_entry.keyword}'.",
                    )
                )

        # Combine weights using diminishing-returns noisy-OR style aggregation in 0–100 scale:
        # 1 - prod(1 - w_i) so multiple independent indicators compound cleanly.
        if not triggered:
            rule_score = 0.0
        else:
            complement = 1.0
            for item in triggered:
                norm_w = (item.weight / 100.0) if item.weight > 1.0 else item.weight
                complement *= max(0.0, 1.0 - min(0.95, norm_w))
            rule_score = round(min(100.0, (1.0 - complement) * 100.0), 2)

        return (
            RuleEngineResult(
                rule_score=rule_score,
                triggered_indicators=triggered,
                suppressed_protective_matches=suppressed_protective,
                duplicate_indicators_skipped=duplicate_count,
                synced_keywords_matched=synced_matched,
            ),
            seen,
        )

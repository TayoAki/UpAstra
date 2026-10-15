// Whisper's languages (ISO 639-1 where one exists), for the "spoken language" picker.
export const LANGUAGES: [string, string][] = [
  ["en", "English"], ["es", "Spanish"], ["pt", "Portuguese"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["nl", "Dutch"],
  ["ru", "Russian"], ["uk", "Ukrainian"], ["pl", "Polish"], ["tr", "Turkish"], ["ar", "Arabic"], ["hi", "Hindi"], ["bn", "Bengali"],
  ["ur", "Urdu"], ["fa", "Persian"], ["he", "Hebrew"], ["zh", "Chinese"], ["ja", "Japanese"], ["ko", "Korean"], ["vi", "Vietnamese"],
  ["th", "Thai"], ["id", "Indonesian"], ["ms", "Malay"], ["tl", "Tagalog"], ["sw", "Swahili"], ["yo", "Yoruba"], ["ha", "Hausa"],
  ["ta", "Tamil"], ["te", "Telugu"], ["mr", "Marathi"], ["gu", "Gujarati"], ["kn", "Kannada"], ["ml", "Malayalam"], ["pa", "Punjabi"],
  ["ne", "Nepali"], ["si", "Sinhala"], ["my", "Burmese"], ["km", "Khmer"], ["lo", "Lao"], ["el", "Greek"], ["cs", "Czech"],
  ["sk", "Slovak"], ["hu", "Hungarian"], ["ro", "Romanian"], ["bg", "Bulgarian"], ["sr", "Serbian"], ["hr", "Croatian"], ["bs", "Bosnian"],
  ["sl", "Slovenian"], ["mk", "Macedonian"], ["sq", "Albanian"], ["lt", "Lithuanian"], ["lv", "Latvian"], ["et", "Estonian"], ["fi", "Finnish"],
  ["sv", "Swedish"], ["no", "Norwegian"], ["nn", "Nynorsk"], ["da", "Danish"], ["is", "Icelandic"], ["ga", "Irish"], ["cy", "Welsh"],
  ["eu", "Basque"], ["ca", "Catalan"], ["gl", "Galician"], ["hy", "Armenian"], ["ka", "Georgian"], ["az", "Azerbaijani"], ["kk", "Kazakh"],
  ["uz", "Uzbek"], ["tg", "Tajik"], ["tk", "Turkmen"], ["mn", "Mongolian"], ["ps", "Pashto"], ["sd", "Sindhi"], ["so", "Somali"],
  ["am", "Amharic"], ["mg", "Malagasy"], ["sn", "Shona"], ["af", "Afrikaans"], ["be", "Belarusian"], ["lb", "Luxembourgish"], ["mt", "Maltese"],
  ["oc", "Occitan"], ["br", "Breton"], ["fo", "Faroese"], ["yi", "Yiddish"], ["la", "Latin"], ["sa", "Sanskrit"], ["bo", "Tibetan"],
  ["as", "Assamese"], ["jw", "Javanese"], ["su", "Sundanese"], ["ht", "Haitian Creole"], ["ln", "Lingala"], ["haw", "Hawaiian"], ["ba", "Bashkir"],
  ["tt", "Tatar"], ["mi", "Maori"], ["yue", "Cantonese"],
];
export const languageName = (code?: string) => LANGUAGES.find(([c]) => c === code)?.[1] ?? code ?? "";

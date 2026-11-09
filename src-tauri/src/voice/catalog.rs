// ABOUTME: Trusted, replaceable catalog entry for Cowrite's first local Whisper model.
// ABOUTME: Pins source revision, exact length, and BLAKE3 before download or admission.

use super::model_registry::ModelSpec;

pub const DEFAULT_MODEL_ID: &str = "base.en-q5_1";
pub const DEFAULT_MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-base.en-q5_1.bin";
pub const DEFAULT_MODEL_BYTE_LEN: u64 = 59_721_011;
pub const DEFAULT_MODEL_BLAKE3: &str =
    "c05ba99dfc1793b884a79254d9ba5d10f8fb0dbb11c89cbb8cb7b1d14031eaef";

#[derive(Clone, Debug)]
pub struct CatalogModel {
    pub spec: ModelSpec,
    pub url: String,
}

pub fn default_model_spec() -> ModelSpec {
    ModelSpec {
        id: DEFAULT_MODEL_ID.into(),
        byte_len: DEFAULT_MODEL_BYTE_LEN,
        blake3: DEFAULT_MODEL_BLAKE3.into(),
    }
}

pub fn default_catalog_model() -> CatalogModel {
    CatalogModel {
        spec: default_model_spec(),
        url: DEFAULT_MODEL_URL.into(),
    }
}

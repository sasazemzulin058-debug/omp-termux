//! Tree-sitter parser functions for all supported languages.

use ast_grep_core::tree_sitter::TSLanguage;

// --- Always compiled grammars (Android + Desktop) ---

pub fn language_bash() -> TSLanguage {
	tree_sitter_bash::LANGUAGE.into()
}
pub fn language_c() -> TSLanguage {
	tree_sitter_c::LANGUAGE.into()
}
pub fn language_cpp() -> TSLanguage {
	tree_sitter_cpp::LANGUAGE.into()
}
pub fn language_go() -> TSLanguage {
	tree_sitter_go::LANGUAGE.into()
}
pub fn language_javascript() -> TSLanguage {
	tree_sitter_javascript::LANGUAGE.into()
}
pub fn language_json() -> TSLanguage {
	tree_sitter_json::LANGUAGE.into()
}
pub fn language_python() -> TSLanguage {
	tree_sitter_python::LANGUAGE.into()
}
pub fn language_rust() -> TSLanguage {
	tree_sitter_rust::LANGUAGE.into()
}
pub fn language_tsx() -> TSLanguage {
	tree_sitter_typescript::LANGUAGE_TSX.into()
}
pub fn language_typescript() -> TSLanguage {
	tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
}
// --- Conditionally compiled grammars (Desktop-only, fallback on Android) ---
#[cfg(not(target_os = "android"))]
pub fn language_c_sharp() -> TSLanguage {
	tree_sitter_c_sharp::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_c_sharp() -> TSLanguage {
	language_cpp()
}

#[cfg(not(target_os = "android"))]
pub fn language_css() -> TSLanguage {
	tree_sitter_css::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_css() -> TSLanguage {
	language_javascript()
}

#[cfg(not(target_os = "android"))]
pub fn language_diff() -> TSLanguage {
	tree_sitter_diff::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_diff() -> TSLanguage {
	language_bash()
}

#[cfg(not(target_os = "android"))]
pub fn language_dockerfile() -> TSLanguage {
	tree_sitter_dockerfile::language()
}
#[cfg(target_os = "android")]
pub fn language_dockerfile() -> TSLanguage {
	language_bash()
}

#[cfg(not(target_os = "android"))]
pub fn language_html() -> TSLanguage {
	tree_sitter_html::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_html() -> TSLanguage {
	language_javascript()
}

#[cfg(not(target_os = "android"))]
pub fn language_java() -> TSLanguage {
	tree_sitter_java::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_java() -> TSLanguage {
	language_cpp()
}

#[cfg(not(target_os = "android"))]
pub fn language_kotlin() -> TSLanguage {
	tree_sitter_kotlin::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_kotlin() -> TSLanguage {
	language_cpp()
}

#[cfg(not(target_os = "android"))]
pub fn language_lua() -> TSLanguage {
	tree_sitter_lua::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_lua() -> TSLanguage {
	language_python()
}

#[cfg(not(target_os = "android"))]
pub fn language_markdown() -> TSLanguage {
	tree_sitter_md::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_markdown() -> TSLanguage {
	language_bash()
}

#[cfg(not(target_os = "android"))]
pub fn language_php() -> TSLanguage {
	tree_sitter_php::LANGUAGE_PHP_ONLY.into()
}
#[cfg(target_os = "android")]
pub fn language_php() -> TSLanguage {
	language_javascript()
}

#[cfg(not(target_os = "android"))]
pub fn language_ruby() -> TSLanguage {
	tree_sitter_ruby::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_ruby() -> TSLanguage {
	language_python()
}

#[cfg(not(target_os = "android"))]
pub fn language_sql() -> TSLanguage {
	tree_sitter_sql::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_sql() -> TSLanguage {
	language_json()
}

#[cfg(not(target_os = "android"))]
pub fn language_swift() -> TSLanguage {
	tree_sitter_swift::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_swift() -> TSLanguage {
	language_rust()
}

#[cfg(not(target_os = "android"))]
pub fn language_toml() -> TSLanguage {
	tree_sitter_toml_ng::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_toml() -> TSLanguage {
	language_json()
}

#[cfg(not(target_os = "android"))]
pub fn language_yaml() -> TSLanguage {
	tree_sitter_yaml::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_yaml() -> TSLanguage {
	language_json()
}


#[cfg(not(target_os = "android"))]
pub fn language_astro() -> TSLanguage {
	tree_sitter_astro::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_astro() -> TSLanguage {
	language_html()
}

#[cfg(not(target_os = "android"))]
pub fn language_clojure() -> TSLanguage {
	tree_sitter_clojure::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_clojure() -> TSLanguage {
	language_javascript()
}

#[cfg(not(target_os = "android"))]
pub fn language_cmake() -> TSLanguage {
	tree_sitter_cmake::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_cmake() -> TSLanguage {
	language_bash()
}

#[cfg(not(target_os = "android"))]
pub fn language_dart() -> TSLanguage {
	tree_sitter_dart::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_dart() -> TSLanguage {
	language_javascript()
}

#[cfg(not(target_os = "android"))]
pub fn language_elixir() -> TSLanguage {
	tree_sitter_elixir::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_elixir() -> TSLanguage {
	language_ruby()
}

#[cfg(not(target_os = "android"))]
pub fn language_elisp() -> TSLanguage {
	tree_sitter_elisp::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_elisp() -> TSLanguage {
	language_clojure()
}

#[cfg(not(target_os = "android"))]
pub fn language_erlang() -> TSLanguage {
	tree_sitter_erlang::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_erlang() -> TSLanguage {
	language_javascript()
}

#[cfg(not(target_os = "android"))]
pub fn language_fortran() -> TSLanguage {
	tree_sitter_fortran::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_fortran() -> TSLanguage {
	language_c()
}

#[cfg(not(target_os = "android"))]
pub fn language_graphql() -> TSLanguage {
	tree_sitter_graphql::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_graphql() -> TSLanguage {
	language_json()
}

#[cfg(not(target_os = "android"))]
pub fn language_haskell() -> TSLanguage {
	tree_sitter_haskell::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_haskell() -> TSLanguage {
	language_rust()
}

#[cfg(not(target_os = "android"))]
pub fn language_hcl() -> TSLanguage {
	tree_sitter_hcl::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_hcl() -> TSLanguage {
	language_json()
}

#[cfg(not(target_os = "android"))]
pub fn language_ini() -> TSLanguage {
	tree_sitter_ini::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_ini() -> TSLanguage {
	language_toml()
}

#[cfg(not(target_os = "android"))]
pub fn language_just() -> TSLanguage {
	tree_sitter_just::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_just() -> TSLanguage {
	language_bash()
}

#[cfg(not(target_os = "android"))]
pub fn language_julia() -> TSLanguage {
	tree_sitter_julia::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_julia() -> TSLanguage {
	language_python()
}

#[cfg(not(target_os = "android"))]
pub fn language_make() -> TSLanguage {
	tree_sitter_make::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_make() -> TSLanguage {
	language_bash()
}

#[cfg(not(target_os = "android"))]
pub fn language_nix() -> TSLanguage {
	tree_sitter_nix::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_nix() -> TSLanguage {
	language_javascript()
}

#[cfg(not(target_os = "android"))]
pub fn language_objc() -> TSLanguage {
	tree_sitter_objc::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_objc() -> TSLanguage {
	language_c()
}

#[cfg(not(target_os = "android"))]
pub fn language_ocaml() -> TSLanguage {
	tree_sitter_ocaml::LANGUAGE_OCAML.into()
}
#[cfg(target_os = "android")]
pub fn language_ocaml() -> TSLanguage {
	language_rust()
}

#[cfg(not(target_os = "android"))]
pub fn language_odin() -> TSLanguage {
	tree_sitter_odin::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_odin() -> TSLanguage {
	language_c()
}

#[cfg(not(target_os = "android"))]
pub fn language_powershell() -> TSLanguage {
	tree_sitter_powershell::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_powershell() -> TSLanguage {
	language_bash()
}

#[cfg(not(target_os = "android"))]
pub fn language_proto() -> TSLanguage {
	tree_sitter_proto::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_proto() -> TSLanguage {
	language_json()
}

#[cfg(not(target_os = "android"))]
pub fn language_r() -> TSLanguage {
	tree_sitter_r::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_r() -> TSLanguage {
	language_python()
}

#[cfg(not(target_os = "android"))]
pub fn language_regex() -> TSLanguage {
	tree_sitter_regex::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_regex() -> TSLanguage {
	language_javascript()
}

#[cfg(not(target_os = "android"))]
pub fn language_scala() -> TSLanguage {
	tree_sitter_scala::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_scala() -> TSLanguage {
	language_java()
}

#[cfg(not(target_os = "android"))]
pub fn language_solidity() -> TSLanguage {
	tree_sitter_solidity::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_solidity() -> TSLanguage {
	language_javascript()
}

#[cfg(not(target_os = "android"))]
pub fn language_starlark() -> TSLanguage {
	tree_sitter_starlark::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_starlark() -> TSLanguage {
	language_python()
}

#[cfg(not(target_os = "android"))]
pub fn language_svelte() -> TSLanguage {
	tree_sitter_svelte::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_svelte() -> TSLanguage {
	language_html()
}

#[cfg(not(target_os = "android"))]
pub fn language_tlaplus() -> TSLanguage {
	tree_sitter_tlaplus::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_tlaplus() -> TSLanguage {
	language_javascript()
}

#[cfg(not(target_os = "android"))]
pub fn language_verilog() -> TSLanguage {
	tree_sitter_verilog::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_verilog() -> TSLanguage {
	language_c()
}

#[cfg(not(target_os = "android"))]
pub fn language_vue() -> TSLanguage {
	tree_sitter_vue::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_vue() -> TSLanguage {
	language_html()
}

#[cfg(not(target_os = "android"))]
pub fn language_xml() -> TSLanguage {
	tree_sitter_xml::LANGUAGE_XML.into()
}
#[cfg(target_os = "android")]
pub fn language_xml() -> TSLanguage {
	language_html()
}

#[cfg(not(target_os = "android"))]
pub fn language_zig() -> TSLanguage {
	tree_sitter_zig::LANGUAGE.into()
}
#[cfg(target_os = "android")]
pub fn language_zig() -> TSLanguage {
	language_c()
}

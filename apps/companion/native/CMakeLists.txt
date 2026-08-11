cmake_minimum_required(VERSION 3.25)
project(fiveprotect_scan LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# The generated protocol plus the hand-written JSON value type.
add_subdirectory("${CMAKE_CURRENT_SOURCE_DIR}/../../../packages/protocol/cpp" protocol)

# A static library rather than a DLL: the shell links it into one binary, so there is one
# file to sign, one build hash to pin, and no separate library an attacker could swap.
add_library(fiveprotect_scan STATIC
    src/probes.cpp
    src/windows_source.cpp
    src/abi.cpp
)
add_library(fiveprotect::scan ALIAS fiveprotect_scan)

target_include_directories(fiveprotect_scan PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(fiveprotect_scan PUBLIC fiveprotect::protocol)

if(WIN32)
    # tbs for the TPM base services, user32 for the window enumeration that tells a running
    # game from a headless one.
    target_link_libraries(fiveprotect_scan PUBLIC tbs user32)
    target_compile_definitions(fiveprotect_scan PRIVATE
        WIN32_LEAN_AND_MEAN
        NOMINMAX
        UNICODE
        _UNICODE
    )
endif()

if(MSVC)
    target_compile_options(fiveprotect_scan PRIVATE /W4 /WX /permissive- /utf-8)
else()
    target_compile_options(fiveprotect_scan PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()

option(FIVEPROTECT_SCAN_TESTS "Build the scan engine tests" ON)

if(FIVEPROTECT_SCAN_TESTS)
    enable_testing()

    add_executable(scan_probes_test test/probes_test.cpp)
    target_link_libraries(scan_probes_test PRIVATE fiveprotect::scan)
    target_include_directories(scan_probes_test PRIVATE
        "${CMAKE_CURRENT_SOURCE_DIR}/../../../packages/protocol/cpp/test"
    )
    if(MSVC)
        target_compile_options(scan_probes_test PRIVATE /W4 /WX /utf-8)
    else()
        target_compile_options(scan_probes_test PRIVATE -Wall -Wextra -Werror)
    endif()
    add_test(NAME scan_probes COMMAND scan_probes_test)

    add_executable(scan_abi_test test/abi_test.cpp)
    target_link_libraries(scan_abi_test PRIVATE fiveprotect::scan)
    target_include_directories(scan_abi_test PRIVATE
        "${CMAKE_CURRENT_SOURCE_DIR}/../../../packages/protocol/cpp/test"
    )
    if(MSVC)
        target_compile_options(scan_abi_test PRIVATE /W4 /WX /utf-8)
    else()
        target_compile_options(scan_abi_test PRIVATE -Wall -Wextra -Werror)
    endif()
    add_test(NAME scan_abi COMMAND scan_abi_test)

    # Prints the snapshot this machine would send. A support and development aid; not part
    # of the shipped companion, and deliberately not a test — its output depends on the
    # machine it runs on.
    add_executable(scan_dump test/dump_main.cpp)
    target_link_libraries(scan_dump PRIVATE fiveprotect::scan)
endif()

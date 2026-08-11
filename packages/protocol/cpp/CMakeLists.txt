cmake_minimum_required(VERSION 3.25)
project(fiveprotect_protocol LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Header-only: the generated protocol plus the hand-written JSON value type. Consumers link
# this and get both include directories, so nothing has to know where generated/ lives.
add_library(fiveprotect_protocol INTERFACE)
add_library(fiveprotect::protocol ALIAS fiveprotect_protocol)

target_include_directories(fiveprotect_protocol INTERFACE
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
    "${CMAKE_CURRENT_SOURCE_DIR}/../generated/cpp"
)

if(MSVC)
    # /W4 plus warnings-as-errors: the engine reads memory it does not own conceptually,
    # and a silent narrowing conversion there is not something to discover in production.
    target_compile_options(fiveprotect_protocol INTERFACE /W4 /permissive- /utf-8)
else()
    target_compile_options(fiveprotect_protocol INTERFACE -Wall -Wextra -Wpedantic)
endif()

option(FIVEPROTECT_PROTOCOL_TESTS "Build the protocol contract tests" ON)

if(FIVEPROTECT_PROTOCOL_TESTS)
    enable_testing()

    add_executable(protocol_json_test test/json_test.cpp)
    target_link_libraries(protocol_json_test PRIVATE fiveprotect::protocol)
    if(MSVC)
        target_compile_options(protocol_json_test PRIVATE /WX)
    else()
        target_compile_options(protocol_json_test PRIVATE -Werror)
    endif()
    add_test(NAME protocol_json COMMAND protocol_json_test)

    add_executable(protocol_contract_test test/contract_test.cpp)
    target_link_libraries(protocol_contract_test PRIVATE fiveprotect::protocol)
    target_compile_definitions(protocol_contract_test PRIVATE
        "FIVEPROTECT_FIXTURES_DIR=\"${CMAKE_CURRENT_SOURCE_DIR}/../fixtures\""
    )
    if(MSVC)
        target_compile_options(protocol_contract_test PRIVATE /WX)
    else()
        target_compile_options(protocol_contract_test PRIVATE -Werror)
    endif()
    add_test(NAME protocol_contract COMMAND protocol_contract_test)
endif()

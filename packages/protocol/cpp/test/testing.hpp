// A test harness small enough to read in one sitting.
//
// The scan engine has no third-party dependencies by design, and its tests inherit that:
// nothing to vendor, nothing to fetch in CI, no build step before the build step.

#ifndef FIVEPROTECT_TESTING_HPP
#define FIVEPROTECT_TESTING_HPP

#include <functional>
#include <iostream>
#include <string>
#include <vector>

namespace fiveprotect::testing {

struct Case {
    std::string name;
    std::function<void()> body;
};

inline std::vector<Case>& registry() {
    static std::vector<Case> cases;
    return cases;
}

struct Registrar {
    Registrar(const char* name, std::function<void()> body) {
        registry().push_back(Case{name, std::move(body)});
    }
};

struct Failure {
    std::string message;
};

inline void fail(const std::string& message) { throw Failure{message}; }

inline void check(bool condition, const std::string& message) {
    if (!condition) fail(message);
}

template <typename A, typename B>
void check_equal(const A& actual, const B& expected, const std::string& message) {
    if (!(actual == expected)) fail(message);
}

inline int run_all() {
    int passed = 0;
    int failed = 0;
    for (const Case& test : registry()) {
        try {
            test.body();
            ++passed;
            std::cout << "  PASS  " << test.name << "\n";
        } catch (const Failure& failure) {
            ++failed;
            std::cout << "  FAIL  " << test.name << "\n        " << failure.message << "\n";
        } catch (const std::exception& error) {
            ++failed;
            std::cout << "  FAIL  " << test.name << "\n        unexpected exception: " << error.what() << "\n";
        }
    }
    std::cout << "\n  " << passed << " passed, " << failed << " failed\n";
    return failed == 0 ? 0 : 1;
}

}  // namespace fiveprotect::testing

#define FIVEPROTECT_TEST(name)                                                            \
    static void name();                                                               \
    static const fiveprotect::testing::Registrar registrar_##name(#name, name);           \
    static void name()

#endif  // FIVEPROTECT_TESTING_HPP

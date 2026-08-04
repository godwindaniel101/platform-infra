-- One database for each service. No service reads the database of the other.
CREATE DATABASE disbursement_db OWNER pact;
CREATE DATABASE switch_db OWNER pact;

-- Test databases. The integration tests use these, so a test run never
-- destroys the data of a local demo.
CREATE DATABASE disbursement_test_db OWNER pact;
CREATE DATABASE switch_test_db OWNER pact;

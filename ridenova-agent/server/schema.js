// Salesforce names used by the agent. Every name below was verified against the
// project's force-app metadata; test/schema.test.js re-checks them on every test run.
export const API_VERSION = '65.0'; // sfdx-project.json -> sourceApiVersion

export const ENUMS = {
  vehicleType: ['Car', 'Bike', 'SUV', 'Van'],
  fuelType: ['Petrol', 'Diesel', 'CNG', 'Electric', 'Hybrid'],
  transmission: ['Manual', 'Automatic'],
  brand: ['Maruti', 'Hyundai', 'Honda', 'Tata', 'Mahindra', 'Toyota', 'Kia', 'MG'],
  issueType: ['Vehicle Breakdown', 'Accident', 'Payment Issue', 'Refund Request', 'Late Return', 'Vehicle Damage', 'Other'],
  priority: ['Low', 'Medium', 'High', 'Critical'],
  ticketOpenStatuses: ['Open', 'Assigned', 'In Progress'],
  vehicleBlockedStatuses: ['Under Maintenance', 'Out of Service'],
  bookingActiveStatuses: ['Pending', 'Confirmed'],
};

// object -> fields the app reads or writes (checked against force-app by the schema test)
export const USED_FIELDS = {
  Vehicle__c: ['Vehicle_Code__c', 'Brand__c', 'Model__c', 'Vehicle_Type__c', 'Fuel_Type__c', 'Transmission__c',
    'Seating_Capacity__c', 'Daily_Rent__c', 'Security_Deposit__c', 'Availability_Status__c',
    'Insurance_Expiry_Date__c', 'RC_Expiry_Date__c', 'Manufacturing_Year__c', 'Color__c'],
  Booking__c: ['Booking_Date__c', 'Booking_Status__c', 'Customer__c', 'Drop_Location__c', 'Payment_Status__c',
    'Pickup_Date__c', 'Pickup_Location__c', 'Return_Date__c', 'Security_Deposit__c', 'Total_Rent__c', 'Vehicle__c'],
  Support_Ticket__c: ['Assigned_To__c', 'Booking__c', 'Customer__c', 'Issue_Type__c', 'Priority__c', 'Ticket_Date__c', 'Ticket_Status__c'],
};
// object -> field -> enum key whose values must exist in that picklist
export const PICKLIST_CHECKS = {
  Vehicle__c: { Vehicle_Type__c: 'vehicleType', Fuel_Type__c: 'fuelType', Transmission__c: 'transmission', Brand__c: 'brand' },
  Support_Ticket__c: { Issue_Type__c: 'issueType', Priority__c: 'priority' },
};
